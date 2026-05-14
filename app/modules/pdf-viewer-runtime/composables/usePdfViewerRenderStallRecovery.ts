import type {
    ComputedRef,
    Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import { PDF_PAGE_STALL_RECOVERY_COOLDOWN_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { TPdfSource } from '@app/types/pdf';
import type { IPageRenderStallPayload } from '@app/composables/pdf/usePdfPageRenderer';

interface IUsePdfViewerRenderStallRecoveryOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    isAnySaving?: Ref<boolean>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    viewerContainer: Ref<HTMLElement | null>;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => unknown;
    cancelInFlightPageRenders?: () => void;
    renderVisiblePages: (
        range: {
            start: number;
            end: number;
        },
        options?: {
            preserveRenderedPages?: boolean;
            forceRerender?: boolean;
            bufferOverride?: number;
        },
    ) => Promise<void>;
    scheduleReload: (isReload?: boolean) => void;
}

export const usePdfViewerRenderStallRecovery = (options: IUsePdfViewerRenderStallRecoveryOptions) => {
    const {
        src,
        isLoading,
        isAnySaving,
        numPages,
        currentPage,
        visibleRange,
        viewerContainer,
        summarizeViewerMetricsForLog,
        cancelInFlightPageRenders,
        renderVisiblePages,
        scheduleReload,
    } = options;

    const pendingRenderStallRecoveryPages = new Set<number>();
    const renderStallRecoveryCooldownByPage = new Map<number, number>();
    let renderStallRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingInvalidation: number[] | null = null;
    let pageLevelRecoveryRunId = 0;

    function clearRenderStallRecoveryTimer() {
        if (renderStallRecoveryTimer !== null) {
            clearTimeout(renderStallRecoveryTimer);
            renderStallRecoveryTimer = null;
        }
    }

    function resetRenderStallRecoveryState() {
        clearRenderStallRecoveryTimer();
        pendingRenderStallRecoveryPages.clear();
        renderStallRecoveryCooldownByPage.clear();
    }

    function invalidatePages(pages: number[]) {
        const next = new Set(pendingInvalidation ?? []);
        pages.forEach(page => next.add(page));
        pendingInvalidation = Array.from(next);
    }

    function consumePendingInvalidation() {
        const pagesToInvalidate = pendingInvalidation;
        pendingInvalidation = null;
        return pagesToInvalidate;
    }

    function handlePageRenderStall(payload: IPageRenderStallPayload) {
        if (!src.value || isLoading.value || isAnySaving?.value) {
            return;
        }

        const maxPage = numPages.value > 0 ? numPages.value : payload.pageNumber;
        const pageNumber = clamp(payload.pageNumber, 1, Math.max(1, maxPage));
        const now = Date.now();
        const cooldownUntil = renderStallRecoveryCooldownByPage.get(pageNumber) ?? 0;
        if (cooldownUntil > now) {
            BrowserLogger.warn(
                'pdf-renderer',
                `Skipped stalled page recovery for page ${pageNumber} during cooldown`,
                {
                    pageNumber,
                    stage: payload.stage,
                    timeoutMs: payload.timeoutMs,
                    cooldownRemainingMs: cooldownUntil - now,
                },
            );
            return;
        }

        renderStallRecoveryCooldownByPage.set(
            pageNumber,
            now + PDF_PAGE_STALL_RECOVERY_COOLDOWN_MS,
        );
        pendingRenderStallRecoveryPages.add(pageNumber);
        BrowserLogger.warn(
            'pdf-renderer',
            `Queued stalled page recovery for page ${pageNumber}`,
            {
                pageNumber,
                stage: payload.stage,
                timeoutMs: payload.timeoutMs,
                currentPage: currentPage.value,
                visibleRange: {
                    start: visibleRange.value.start,
                    end: visibleRange.value.end,
                },
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
            },
        );

        if (renderStallRecoveryTimer !== null) {
            return;
        }

        renderStallRecoveryTimer = setTimeout(() => {
            renderStallRecoveryTimer = null;
            if (!src.value) {
                pendingRenderStallRecoveryPages.clear();
                return;
            }

            const pages = Array.from(pendingRenderStallRecoveryPages)
                .sort((left, right) => left - right);
            pendingRenderStallRecoveryPages.clear();
            if (pages.length === 0) {
                return;
            }

            BrowserLogger.warn(
                'pdf-renderer',
                'Retrying stalled PDF page render without source reload',
                {
                    pages,
                    currentPage: currentPage.value,
                    visibleRange: {
                        start: visibleRange.value.start,
                        end: visibleRange.value.end,
                    },
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                },
            );
            const recoveryRunId = ++pageLevelRecoveryRunId;
            cancelInFlightPageRenders?.();
            invalidatePages(pages);
            void renderVisiblePages(
                {
                    start: pages[0]!,
                    end: pages[pages.length - 1]!,
                },
                {
                    preserveRenderedPages: true,
                    forceRerender: true,
                    bufferOverride: 0,
                },
            ).catch((error: unknown) => {
                if (recoveryRunId !== pageLevelRecoveryRunId || isLoading.value || !src.value) {
                    return;
                }

                BrowserLogger.warn(
                    'pdf-renderer',
                    'Page-level stalled render recovery failed; scheduling selective source reload',
                    {
                        pages,
                        currentPage: currentPage.value,
                        visibleRange: {
                            start: visibleRange.value.start,
                            end: visibleRange.value.end,
                        },
                        error: error instanceof Error ? error.message : String(error),
                    },
                );
                scheduleReload(true);
            });
        }, 0);
    }

    return {
        clearRenderStallRecoveryTimer,
        resetRenderStallRecoveryState,
        invalidatePages,
        consumePendingInvalidation,
        handlePageRenderStall,
    };
};
