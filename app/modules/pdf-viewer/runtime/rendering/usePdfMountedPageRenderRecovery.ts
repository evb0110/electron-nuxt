import type { IPageRange } from '@app/types/pdf';
import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisor,
    type IPdfRenderSupervisorTimer,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';

interface IUsePdfMountedPageRenderRecoveryOptions {
    isActive: MaybeRefOrGetter<boolean>;
    isLoading: Ref<boolean>;
    hasDocument: MaybeRefOrGetter<boolean>;
    numPages: Ref<number>;
    /**
     * Temporarily disables late-mount recovery while another renderer owns it.
     *
     * Recovery is a fallback for pages that mounted after a render attempt
     * missed the DOM target. During fit-height/fit-width current-page
     * rerenders, the coordinator intentionally waits for metrics and then
     * force-renders the row; letting recovery render the same newly mounted
     * page first restarts the PDF.js same-page cancellation race.
     */
    suppressRecovery?: MaybeRefOrGetter<boolean> | undefined;
    isPageMounted?: ((pageNumber: number) => boolean) | undefined;
    shouldRecoverPage: (pageNumber: number) => boolean;
    renderVisiblePages: (
        range: IPageRange,
        options: {
            preserveRenderedPages: true;
            bufferOverride: 0;
            preserveInFlightRequiredPages: true;
        },
    ) => Promise<void>;
    resolveRecoveryRange?: ((pageNumber: number) => IPageRange | null | undefined) | undefined;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
}

const MOUNTED_PAGE_RENDER_RETRY_DELAYS_MS = [
    0,
    160,
    600,
    1_500,
] as const;

function normalizePageNumber(pageNumber: number, totalPages: number) {
    if (!Number.isFinite(pageNumber) || totalPages <= 0) {
        return null;
    }

    const normalized = Math.trunc(pageNumber);
    if (normalized < 1 || normalized > totalPages) {
        return null;
    }

    return normalized;
}

function toContiguousPageRanges(pageNumbers: number[]) {
    const sortedPages = [...new Set(pageNumbers)]
        .sort((left, right) => left - right);
    const ranges: IPageRange[] = [];

    for (const pageNumber of sortedPages) {
        const activeRange = ranges[ranges.length - 1];
        if (activeRange && pageNumber === activeRange.end + 1) {
            activeRange.end = pageNumber;
            continue;
        }

        ranges.push({
            start: pageNumber,
            end: pageNumber,
        });
    }

    return ranges;
}

export const usePdfMountedPageRenderRecovery = (options: IUsePdfMountedPageRenderRecoveryOptions) => {
    const renderSupervisor = options.renderSupervisor ?? createPdfRenderSupervisor();
    const pendingPages = new Map<number, number>();
    let retryTimer: IPdfRenderSupervisorTimer | null = null;
    let isRenderPassActive = false;
    let recoveryRunId = 0;

    function clearRetryTimer() {
        renderSupervisor.clearTimer(retryTimer);
        retryTimer = null;
    }

    function canTrackPendingPage(pageNumber: number) {
        return toValue(options.isActive)
            && !options.isLoading.value
            && toValue(options.hasDocument)
            && options.shouldRecoverPage(pageNumber);
    }

    function isPageMountedForRecovery(pageNumber: number) {
        return options.isPageMounted?.(pageNumber) !== false;
    }

    function canRecoverPage(pageNumber: number) {
        return canTrackPendingPage(pageNumber)
            && isPageMountedForRecovery(pageNumber)
            && !toValue(options.suppressRecovery ?? false);
    }

    function getRecoverablePages() {
        return Array.from(pendingPages.keys())
            .filter(pageNumber => canRecoverPage(pageNumber));
    }

    function getRecoveryRenderRanges(pageNumbers: number[]) {
        const pagesToRender = new Set<number>();
        for (const pageNumber of pageNumbers) {
            const range = options.resolveRecoveryRange?.(pageNumber) ?? {
                start: pageNumber,
                end: pageNumber,
            };
            const start = normalizePageNumber(range.start, options.numPages.value);
            const end = normalizePageNumber(range.end, options.numPages.value);
            if (start === null || end === null) {
                pagesToRender.add(pageNumber);
                continue;
            }
            for (let page = Math.min(start, end); page <= Math.max(start, end); page += 1) {
                pagesToRender.add(page);
            }
        }
        return toContiguousPageRanges([...pagesToRender]);
    }

    function pruneUnrecoverablePendingPages() {
        for (const pageNumber of Array.from(pendingPages.keys())) {
            if (!canTrackPendingPage(pageNumber) || !isPageMountedForRecovery(pageNumber)) {
                pendingPages.delete(pageNumber);
            }
        }
    }

    function scheduleRenderPass(delayMs = 0) {
        if (retryTimer !== null || isRenderPassActive) {
            return;
        }

        const runId = recoveryRunId;
        retryTimer = renderSupervisor.armTimer({
            cause: 'mounted-page-recovery',
            delayMs,
            key: 'mounted-page-render-recovery',
            metadata: {
                pendingPages: Array.from(pendingPages.keys()),
                runId,
            },
            onFire: () => {
                retryTimer = null;
                void runRenderPass(runId);
            },
        });
    }

    function scheduleRetryForPages(pageNumbers: number[]) {
        let nextDelayMs: number | null = null;

        for (const pageNumber of pageNumbers) {
            const attempt = pendingPages.get(pageNumber) ?? 0;
            if (attempt >= MOUNTED_PAGE_RENDER_RETRY_DELAYS_MS.length) {
                pendingPages.delete(pageNumber);
                BrowserLogger.warnThrottled(
                    'pdf-renderer',
                    `mounted-page-render-recovery-exhausted:${pageNumber}`,
                    1_000,
                    `Exhausted mounted page render recovery for page ${pageNumber}`,
                    {
                        pageNumber,
                        attempt,
                        totalPages: options.numPages.value,
                    },
                );
                continue;
            }

            const pageDelay = MOUNTED_PAGE_RENDER_RETRY_DELAYS_MS[attempt] ?? 0;
            nextDelayMs = nextDelayMs === null
                ? pageDelay
                : Math.min(nextDelayMs, pageDelay);
        }

        if (nextDelayMs !== null) {
            scheduleRenderPass(nextDelayMs);
        }
    }

    async function runRenderPass(runId: number) {
        if (runId !== recoveryRunId) {
            return;
        }

        const pages = getRecoverablePages();
        if (pages.length === 0) {
            pruneUnrecoverablePendingPages();
            return;
        }

        isRenderPassActive = true;
        for (const pageNumber of pages) {
            pendingPages.set(pageNumber, (pendingPages.get(pageNumber) ?? 0) + 1);
        }

        try {
            await nextTick();
            if (runId !== recoveryRunId) {
                return;
            }

            for (const range of getRecoveryRenderRanges(getRecoverablePages())) {
                await options.renderVisiblePages(range, {
                    preserveRenderedPages: true,
                    bufferOverride: 0,
                    preserveInFlightRequiredPages: true,
                });
            }
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to recover mounted PDF page render',
                error,
            );
        } finally {
            isRenderPassActive = false;
        }

        const stillRecoverablePages = getRecoverablePages();
        const stillRecoverablePageSet = new Set(stillRecoverablePages);
        for (const pageNumber of Array.from(pendingPages.keys())) {
            if (!canTrackPendingPage(pageNumber) || !isPageMountedForRecovery(pageNumber)) {
                pendingPages.delete(pageNumber);
                continue;
            }

            if (
                !toValue(options.suppressRecovery ?? false)
                && !stillRecoverablePageSet.has(pageNumber)
            ) {
                pendingPages.delete(pageNumber);
            }
        }
        scheduleRetryForPages(stillRecoverablePages);
    }

    /**
     * Treat a Vue page-container mount as an eventual-render recovery signal.
     *
     * Large jumps can mount the target page after the renderer's short,
     * request-bound "missing render target" retry has already exhausted. When
     * that happens no scroll event necessarily follows, so the visible page can
     * remain a skeleton forever. The caller deliberately narrows
     * `shouldRecoverPage` to the current visible row instead of the broader
     * skeleton buffer, and it excludes pages that are already rendering: pages
     * mounted during a superseded rapid navigation burst must not revive
     * themselves, and repeated recovery retries must not cancel the active
     * canvas render for the real target. This queue then retries with backoff
     * after the render promise settles, which avoids overlapping with the
     * normal visible-render pipeline while closing the late-mount gap.
     */
    function queueMountedPageRender(pageNumber: number) {
        const normalizedPage = normalizePageNumber(pageNumber, options.numPages.value);
        if (normalizedPage === null || !canTrackPendingPage(normalizedPage)) {
            return;
        }

        pendingPages.set(
            normalizedPage,
            pendingPages.get(normalizedPage) ?? 0,
        );
        if (canRecoverPage(normalizedPage)) {
            scheduleRetryForPages([normalizedPage]);
        }
    }

    function cleanupMountedPageRenderRecovery() {
        recoveryRunId += 1;
        clearRetryTimer();
        pendingPages.clear();
        isRenderPassActive = false;
    }

    onScopeDispose(cleanupMountedPageRenderRecovery);

    watch(
        () => [
            toValue(options.isActive),
            options.isLoading.value,
            toValue(options.hasDocument),
            toValue(options.suppressRecovery ?? false),
        ] as const,
        () => {
            pruneUnrecoverablePendingPages();
            const recoverablePages = getRecoverablePages();
            if (recoverablePages.length > 0) {
                scheduleRetryForPages(recoverablePages);
            }
        },
        { flush: 'post' },
    );

    return {
        queueMountedPageRender,
        cleanupMountedPageRenderRecovery,
    };
};
