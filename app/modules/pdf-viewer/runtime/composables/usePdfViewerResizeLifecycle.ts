import type { Ref } from 'vue';
import {useResizeObserver} from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    ICurrentPageSyncOptions,
    IResizeAnchorContext,
    summarizeViewerMetrics,
} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import { PDF_RERENDER_SOURCE } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import type {
    IPdfViewerTransaction,
    IPdfViewerTransactionCancellation,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import {
    PDF_RESIZE_DRAG_SETTLE_MS,
    PDF_RESIZE_RERENDER_DEBOUNCE_MS,
    PDF_RESIZE_TRANSITION_HIDE_MS,
} from '@app/constants/timeouts';
import { delay } from 'es-toolkit/promise';

type TViewerMetrics = ReturnType<typeof summarizeViewerMetrics>;

export interface IBuildResizeAnchorContextOptions {
    preferredAnchorPage?: number | null;
    trustPreferredAnchorPage?: boolean;
}

interface IUsePdfViewerResizeLifecycleOptions {
    submitResizeIntent: (anchor?: IPdfSemanticAnchor | null) => void;
    captureViewportAnchor?: (() => IPdfSemanticAnchor | null) | undefined;
    viewerContainer: Ref<HTMLElement | null>;
    isLoading: Ref<boolean>;
    isActive?: Ref<boolean> | undefined;
    isResizing: Ref<boolean>;
    pdfDocument: Ref<unknown | null>;
    currentPage: Ref<number>;
    pendingNavigationAnchorPage?: Readonly<Ref<number | null>> | undefined;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    numPages: Ref<number>;
    computeFitWidthScale: (
        container: HTMLElement | null,
        options?: {
            page?: number | null;
            preview?: boolean
        },
    ) => boolean;
    clearPreviewFitScale?: (() => void) | undefined;
    getMostVisiblePage: (container: HTMLElement | null, numPages: number) => number;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => TViewerMetrics;
    summarizeVisiblePageSnapshotForLog: (container: HTMLElement | null) => unknown;
    scheduleResizeAwareRerender: (
        stage: string,
        syncOptions?: ICurrentPageSyncOptions,
    ) => void;
    setResizeTransitionVisible?: ((payload: {
        active: boolean;
        source: string;
        token: number;
        anchorPage: number | null;
    }) => void) | undefined;
    transactionController?: IResizeLifecycleTransactionController | undefined;
}

interface IResizeLifecycleTransactionController {
    beginTransaction: (options: {
        kind: 'resize';
        source: 'resize-observer' | 'resize-settle';
        page?: number | null | undefined;
        range?: IResizeAnchorContext['visibleRange'] | undefined;
        anchor?: NonNullable<IPdfViewerTransaction['target']>['anchor'];
    }) => IPdfViewerTransaction | null;
    cancelActiveTransaction: (
        cancellation: IPdfViewerTransactionCancellation,
        transactionId?: number | undefined,
    ) => boolean;
    isTransactionCurrent: (transactionId: number) => boolean;
}

export const usePdfViewerResizeLifecycle = (options: IUsePdfViewerResizeLifecycleOptions) => {
    const {
        viewerContainer,
        isLoading,
        isActive,
        isResizing,
        pdfDocument,
        currentPage,
        visibleRange,
        numPages,
        computeFitWidthScale,
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        scheduleResizeAwareRerender,
        setResizeTransitionVisible,
    } = options;

    const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;
    let resizeTransitionToken = 0;
    let pendingResizeTransitionHideTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingResizeAnchor: IResizeAnchorContext | null = null;
    let pendingResizeTransactionId: number | null = null;
    let dragResizeAnchor: IResizeAnchorContext | null = null;
    let dragSettleRunId = 0;
    let dragSettleClaimed = false;
    let dragSettleClaimReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingResizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    function beginResizeTransaction(
        anchor: IResizeAnchorContext,
        source: 'resize-observer' | 'resize-settle',
    ) {
        const transaction = options.transactionController?.beginTransaction({
            kind: 'resize',
            source,
            page: anchor.page,
            range: anchor.visibleRange,
            anchor: 'center',
        }) ?? null;
        pendingResizeTransactionId = transaction?.id ?? null;
        return pendingResizeTransactionId;
    }

    function cancelPendingResizeTransaction(reason: IPdfViewerTransactionCancellation['reason']) {
        if (pendingResizeTransactionId === null) {
            return;
        }
        options.transactionController?.cancelActiveTransaction({
            reason,
            cancelInFlightRenders: true,
            bumpRenderVersion: reason === 'resize',
            preserveVisualContent: true,
        }, pendingResizeTransactionId);
        pendingResizeTransactionId = null;
    }

    function emitResizeTransitionSignal(
        active: boolean,
        source: string,
        token: number,
        anchorPage: number | null,
    ) {
        setResizeTransitionVisible?.({
            active,
            source,
            token,
            anchorPage,
        });
    }

    function beginResizeTransition(source: string, anchorPage: number | null) {
        resizeTransitionToken += 1;
        const token = resizeTransitionToken;
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
            pendingResizeTransitionHideTimer = null;
        }
        emitResizeTransitionSignal(true, source, token, anchorPage);
        return token;
    }

    function scheduleEndResizeTransition(
        token: number,
        source: string,
        anchorPage: number | null,
    ) {
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
        }
        pendingResizeTransitionHideTimer = setTimeout(() => {
            if (token !== resizeTransitionToken) {
                return;
            }
            emitResizeTransitionSignal(false, source, token, anchorPage);
            pendingResizeTransitionHideTimer = null;
        }, PDF_RESIZE_TRANSITION_HIDE_MS);
    }

    function normalizePreferredAnchorPage(page: number | null | undefined) {
        if (
            typeof page !== 'number'
            || !Number.isFinite(page)
            || page < 1
            || page > numPages.value
        ) {
            return null;
        }
        return Math.trunc(page);
    }

    function getResizePreferredAnchorPage() {
        return options.pendingNavigationAnchorPage?.value ?? currentPage.value;
    }

    function buildResizeAnchorContext(optionsOverride?: IBuildResizeAnchorContextOptions) {
        if (isActive?.value === false) {
            return {
                capturedAtMs: Date.now(),
                page: currentPage.value,
                transitionToken: 0,
                visibleRange: {
                    start: visibleRange.value.start,
                    end: visibleRange.value.end,
                },
                viewerMetrics: summarizeViewerMetricsForLog(viewerContainer.value),
                semanticAnchor: options.captureViewportAnchor?.() ?? null,
            } satisfies IResizeAnchorContext;
        }
        const preferredAnchorPage = optionsOverride?.trustPreferredAnchorPage
            ? normalizePreferredAnchorPage(optionsOverride.preferredAnchorPage)
            : null;
        const anchorPage = preferredAnchorPage ?? currentPage.value;
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'anchor-build-captured', ZOOM_QUEUE_LOG_THROTTLE_MS, '[anchor-build] captured', {
            optionsOverride: optionsOverride ?? null,
            anchorPage,
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        });
        return {
            capturedAtMs: Date.now(),
            page: anchorPage,
            transitionToken: 0,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewerMetrics: summarizeViewerMetricsForLog(viewerContainer.value),
            semanticAnchor: options.captureViewportAnchor?.() ?? null,
        } satisfies IResizeAnchorContext;
    }

    function runDebouncedResizeRender() {
        pendingResizeDebounceTimer = null;
        if (isActive?.value === false || isLoading.value || !pdfDocument.value) {
            if (pendingResizeAnchor) {
                scheduleEndResizeTransition(
                    pendingResizeAnchor.transitionToken,
                    'resize-cancelled',
                    pendingResizeAnchor.page,
                );
            }
            pendingResizeAnchor = null;
            cancelPendingResizeTransaction('resize');
            return;
        }
        const anchor = pendingResizeAnchor;
        const transactionId = pendingResizeTransactionId;
        const isTransactionCurrent = transactionId === null
            || options.transactionController?.isTransactionCurrent(transactionId) !== false;
        pendingResizeAnchor = null;
        pendingResizeTransactionId = null;
        if (!isTransactionCurrent) {
            if (anchor) {
                scheduleEndResizeTransition(
                    anchor.transitionToken,
                    'resize-stale',
                    anchor.page,
                );
            }
            return;
        }
        scheduleResizeAwareRerender('re-render visible pages after resize', {
            source: PDF_RERENDER_SOURCE.ResizeObserver,
            stabilize: true,
            resizeAnchor: anchor,
            ...(transactionId !== null ? { transactionId } : {}),
        });
    }

    function cancelDebouncedResizeRender() {
        if (pendingResizeDebounceTimer !== null) {
            clearTimeout(pendingResizeDebounceTimer);
            pendingResizeDebounceTimer = null;
        }
    }

    function scheduleDebouncedResizeRender() {
        cancelDebouncedResizeRender();
        pendingResizeDebounceTimer = setTimeout(
            runDebouncedResizeRender,
            PDF_RESIZE_RERENDER_DEBOUNCE_MS,
        );
    }

    function restoreResizeAnchorAfterLayout(anchor: IResizeAnchorContext, source: string) {
        options.submitResizeIntent(anchor.semanticAnchor);
        BrowserLogger.diagnosticThrottled(
            'pdf-zoom-debug',
            'resize-anchor-authority-intent',
            ZOOM_QUEUE_LOG_THROTTLE_MS,
            '[resize-anchor] submitted semantic viewport intent',
            {
                source,
                token: anchor.transitionToken,
                anchorPage: anchor.page,
            },
        );
    }

    function handleResize() {
        if (isActive?.value === false) {
            return;
        }
        if (isLoading.value) {
            return;
        }
        if (isResizing.value) {
            computeFitWidthScale(viewerContainer.value, {
                page: dragResizeAnchor?.page ?? currentPage.value,
                preview: true,
            });
            return;
        }
        if (dragSettleClaimed) {
            return;
        }
        const preferredAnchorPage = getResizePreferredAnchorPage();
        const resizeAnchor = buildResizeAnchorContext({
            preferredAnchorPage,
            trustPreferredAnchorPage: true,
        });
        const updated = computeFitWidthScale(viewerContainer.value);
        if (pdfDocument.value) {
            if (pendingResizeAnchor) {
                BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'resize-anchor-preserved', ZOOM_QUEUE_LOG_THROTTLE_MS, '[resize-anchor] preserved first anchor in resize burst', {
                    updated,
                    preservedAnchorPage: pendingResizeAnchor.page,
                    ignoredAnchorPage: resizeAnchor.page,
                    preservedAnchorAgeMs: Date.now() - pendingResizeAnchor.capturedAtMs,
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                });
                scheduleDebouncedResizeRender();
                return;
            }
            const transitionToken = beginResizeTransition(
                PDF_RERENDER_SOURCE.ResizeObserver,
                resizeAnchor.page,
            );
            const anchoredResizeContext: IResizeAnchorContext = {
                ...resizeAnchor,
                transitionToken,
            };
            beginResizeTransaction(anchoredResizeContext, 'resize-observer');
            pendingResizeAnchor = anchoredResizeContext;
            restoreResizeAnchorAfterLayout(anchoredResizeContext, PDF_RERENDER_SOURCE.ResizeObserver);
            BrowserLogger.diagnostic('pdf-nav', 'Resize observer requested re-render'
                + ` anchorPage=${anchoredResizeContext.page}`
                + ` anchorRange=${anchoredResizeContext.visibleRange.start}-${anchoredResizeContext.visibleRange.end}`
                + ` token=${anchoredResizeContext.transitionToken}`, {
                currentPage: currentPage.value,
                visibleRange: {
                    start: visibleRange.value.start,
                    end: visibleRange.value.end,
                },
                anchorViewerMetrics: anchoredResizeContext.viewerMetrics,
                pendingAnchorPage: pendingResizeAnchor.page,
                pendingAnchorAgeMs: Date.now() - pendingResizeAnchor.capturedAtMs,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
            });
            scheduleDebouncedResizeRender();
        }
    }

    useResizeObserver(viewerContainer, handleResize);

    watch(isResizing, async (value, previous) => {
        const runId = ++dragSettleRunId;
        if (value) {
            dragSettleClaimed = true;
            cancelDebouncedResizeRender();
            if (pendingResizeAnchor) {
                scheduleEndResizeTransition(
                    pendingResizeAnchor.transitionToken,
                    'resize-observer-superseded-by-drag',
                    pendingResizeAnchor.page,
                );
                pendingResizeAnchor = null;
            }
            cancelPendingResizeTransaction('resize');
            const anchor = buildResizeAnchorContext({
                preferredAnchorPage: getResizePreferredAnchorPage(),
                trustPreferredAnchorPage: true,
            });
            dragResizeAnchor = {
                ...anchor,
                transitionToken: beginResizeTransition(PDF_RERENDER_SOURCE.ResizeSettle, anchor.page),
            };
            computeFitWidthScale(viewerContainer.value, {
                page: anchor.page,
                preview: true,
            });
            return;
        }
        if (!previous || !dragResizeAnchor) {
            dragSettleClaimed = false;
            return;
        }

        await nextTick();
        await delay(PDF_RESIZE_DRAG_SETTLE_MS);
        if (
            runId !== dragSettleRunId
            || isResizing.value
            || isActive?.value === false
            || isLoading.value
            || !pdfDocument.value
        ) {
            return;
        }

        const anchor = dragResizeAnchor;
        dragResizeAnchor = null;
        computeFitWidthScale(viewerContainer.value, {page: anchor.page});
        options.clearPreviewFitScale?.();
        beginResizeTransaction(anchor, 'resize-settle');
        restoreResizeAnchorAfterLayout(anchor, PDF_RERENDER_SOURCE.ResizeSettle);
        const transactionId = pendingResizeTransactionId;
        pendingResizeTransactionId = null;
        scheduleResizeAwareRerender('re-render visible pages after resize settle', {
            source: PDF_RERENDER_SOURCE.ResizeSettle,
            stabilize: true,
            resizeAnchor: anchor,
            ...(transactionId !== null ? {transactionId} : {}),
        });
        if (dragSettleClaimReleaseTimer !== null) {
            clearTimeout(dragSettleClaimReleaseTimer);
        }
        dragSettleClaimReleaseTimer = setTimeout(() => {
            dragSettleClaimed = false;
            dragSettleClaimReleaseTimer = null;
        }, PDF_RESIZE_TRANSITION_HIDE_MS);
    }, {flush: 'sync'});

    function cleanupResizeLifecycle() {
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
            pendingResizeTransitionHideTimer = null;
        }
        pendingResizeAnchor = null;
        dragResizeAnchor = null;
        dragSettleRunId += 1;
        dragSettleClaimed = false;
        if (dragSettleClaimReleaseTimer !== null) {
            clearTimeout(dragSettleClaimReleaseTimer);
            dragSettleClaimReleaseTimer = null;
        }
        cancelDebouncedResizeRender();
        options.clearPreviewFitScale?.();
        cancelPendingResizeTransaction('disposed');
        resizeTransitionToken += 1;
        emitResizeTransitionSignal(false, 'unmount', resizeTransitionToken, currentPage.value);
    }

    return {
        buildResizeAnchorContext,
        beginResizeTransition,
        scheduleEndResizeTransition,
        cleanupResizeLifecycle,
    };
};
