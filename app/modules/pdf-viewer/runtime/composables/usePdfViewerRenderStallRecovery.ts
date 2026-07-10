import type {
    ComputedRef,
    Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import { PDF_PAGE_STALL_RECOVERY_COOLDOWN_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { TPdfSource } from '@app/types/pdfUi';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisor,
    type IPdfRenderSupervisorTimer,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type {
    IPdfViewerTransactionCancellation,
    TPdfViewerTransactionState,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';

type TRenderStallRecoveryAdvanceState = Exclude<
    TPdfViewerTransactionState,
    'preparing' | 'cancelled'
>;

interface IRenderStallRecoveryTransactionController {
    beginTransaction: (options: {
        kind: 'recovery';
        source: 'render-stall-recovery';
        page: number;
        range: {
            start: number;
            end: number;
        };
        anchor: 'top';
    }) => { id: number } | null;
    advanceTransaction: (
        transactionId: number,
        state: TRenderStallRecoveryAdvanceState,
    ) => boolean;
    cancelActiveTransaction: (
        cancellation: IPdfViewerTransactionCancellation,
        transactionId?: number,
    ) => boolean;
    isTransactionCurrent: (transactionId: number) => boolean;
}

interface IUsePdfViewerRenderStallRecoveryOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    isAnySaving?: Ref<boolean> | undefined;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    viewerContainer: Ref<HTMLElement | null>;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => unknown;
    cancelInFlightPageRenders?: (() => Promise<void> | void) | undefined;
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
    renderSupervisor?: IPdfRenderSupervisor | undefined;
    transactionController?: IRenderStallRecoveryTransactionController | undefined;
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
        renderSupervisor = createPdfRenderSupervisor(),
    } = options;

    const pendingRenderStallRecoveryPages = new Set<number>();
    const renderStallRecoveryCooldownByPage = new Map<number, number>();
    let renderStallRecoveryTimer: IPdfRenderSupervisorTimer | null = null;
    let pendingInvalidation: number[] | null = null;
    let pageLevelRecoveryRunId = 0;
    let activeRecoveryTransactionId: number | null = null;

    function createRecoveryCancellation(
        reason: IPdfViewerTransactionCancellation['reason'],
    ): IPdfViewerTransactionCancellation {
        return {
            reason,
            cancelInFlightRenders: false,
            bumpRenderVersion: false,
            clearTimers: true,
            preserveVisualContent: true,
        };
    }

    function cancelRecoveryTransaction(reason: IPdfViewerTransactionCancellation['reason']) {
        const transactionId = activeRecoveryTransactionId;
        if (transactionId === null) {
            return true;
        }
        if (
            options.transactionController
            && !options.transactionController.isTransactionCurrent(transactionId)
        ) {
            activeRecoveryTransactionId = null;
            return true;
        }
        const didCancel = options.transactionController?.cancelActiveTransaction(
            createRecoveryCancellation(reason),
            transactionId,
        ) ?? true;
        activeRecoveryTransactionId = null;
        return didCancel;
    }

    function beginRecoveryTransaction(pages: number[]) {
        const range = {
            start: pages[0]!,
            end: pages[pages.length - 1]!,
        };
        const transaction = options.transactionController?.beginTransaction({
            kind: 'recovery',
            source: 'render-stall-recovery',
            page: range.start,
            range,
            anchor: 'top',
        });
        if (options.transactionController && !transaction) {
            return null;
        }
        activeRecoveryTransactionId = transaction?.id ?? null;
        return activeRecoveryTransactionId;
    }

    function isRecoveryTransactionCurrent(transactionId: number | null) {
        return transactionId === null
            || options.transactionController?.isTransactionCurrent(transactionId) !== false;
    }

    function advanceRecoveryTransaction(
        transactionId: number | null,
        state: TRenderStallRecoveryAdvanceState,
    ) {
        if (transactionId === null) {
            return true;
        }
        return options.transactionController?.advanceTransaction(transactionId, state) ?? true;
    }

    function settleRecoveryTransaction(transactionId: number | null) {
        if (transactionId === null) {
            return true;
        }
        const didSettle = options.transactionController?.advanceTransaction(transactionId, 'settled') ?? true;
        if (activeRecoveryTransactionId === transactionId) {
            activeRecoveryTransactionId = null;
        }
        return didSettle;
    }

    function clearRenderStallRecoveryTimer() {
        renderSupervisor.clearTimer(renderStallRecoveryTimer);
        renderStallRecoveryTimer = null;
    }

    function resetRenderStallRecoveryState() {
        clearRenderStallRecoveryTimer();
        pageLevelRecoveryRunId += 1;
        cancelRecoveryTransaction('superseded');
        pendingRenderStallRecoveryPages.clear();
        renderStallRecoveryCooldownByPage.clear();
        pendingInvalidation = null;
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

        renderStallRecoveryTimer = renderSupervisor.armTimer({
            cause: 'render-stall-recovery',
            delayMs: 0,
            key: 'render-stall-recovery',
            metadata: {
                queuedPage: pageNumber,
                stage: payload.stage,
                timeoutMs: payload.timeoutMs,
            },
            onFire: () => {
                renderStallRecoveryTimer = null;
                if (!src.value) {
                    pageLevelRecoveryRunId += 1;
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
                const recoveryTransactionId = beginRecoveryTransaction(pages);
                const ownsRecoveryTransaction = (
                    !options.transactionController
                    || recoveryTransactionId !== null
                );
                if (ownsRecoveryTransaction) {
                    void cancelInFlightPageRenders?.();
                }
                invalidatePages(pages);
                advanceRecoveryTransaction(recoveryTransactionId, 'render-requested');
                void renderVisiblePages({
                    start: pages[0]!,
                    end: pages[pages.length - 1]!,
                }, {
                    preserveRenderedPages: true,
                    forceRerender: true,
                    bufferOverride: 0,
                }).then(() => {
                    if (
                        recoveryRunId !== pageLevelRecoveryRunId
                        || !isRecoveryTransactionCurrent(recoveryTransactionId)
                    ) {
                        return;
                    }
                    settleRecoveryTransaction(recoveryTransactionId);
                }).catch((error: unknown) => {
                    if (
                        recoveryRunId !== pageLevelRecoveryRunId
                        || isLoading.value
                        || !src.value
                        || !isRecoveryTransactionCurrent(recoveryTransactionId)
                    ) {
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
                    cancelRecoveryTransaction('timeout');
                    scheduleReload(true);
                });
            },
        });
    }

    return {
        clearRenderStallRecoveryTimer,
        resetRenderStallRecoveryState,
        invalidatePages,
        consumePendingInvalidation,
        handlePageRenderStall,
    };
};
