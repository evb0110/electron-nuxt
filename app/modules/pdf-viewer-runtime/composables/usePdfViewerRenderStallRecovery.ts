import type {
    ComputedRef,
    Ref,
} from 'vue';
import { PDF_PAGE_STALL_RECOVERY_COOLDOWN_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browser-logger';
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
    scheduleReload: (isReload?: boolean) => void;
}

export function usePdfViewerRenderStallRecovery(options: IUsePdfViewerRenderStallRecoveryOptions) {
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
        scheduleReload,
    } = options;

    const pendingRenderStallRecoveryPages = new Set<number>();
    const renderStallRecoveryCooldownByPage = new Map<number, number>();
    let renderStallRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingInvalidation: number[] | null = null;

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
        const pageNumber = Math.max(1, Math.min(payload.pageNumber, maxPage));
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
                'Reloading PDF source to recover stalled page render',
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
            cancelInFlightPageRenders?.();
            invalidatePages(pages);
            scheduleReload(true);
        }, 0);
    }

    return {
        clearRenderStallRecoveryTimer,
        resetRenderStallRecoveryState,
        invalidatePages,
        consumePendingInvalidation,
        handlePageRenderStall,
    };
}
