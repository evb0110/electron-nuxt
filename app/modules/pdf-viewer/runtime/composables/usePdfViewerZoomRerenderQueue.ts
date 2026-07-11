import type { Ref } from 'vue';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import type {
    ICurrentPageSyncOptions,
    IResizeAnchorContext,
} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import {
    PDF_RERENDER_SOURCE,
    isResizePdfRerenderSource,
    normalizePdfRerenderSource,
} from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import type {
    IPdfViewerTransaction,
    IPdfViewerTransactionCancellation,
    TPdfViewerTransactionSource,
    TPdfViewerTransactionState,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { TZoomInteractionLockOperationId } from '@app/modules/pdf-viewer/runtime/zoom/pdfViewerZoomTypes';
import { PDF_RESIZE_DEFERRED_BEHIND_ZOOM_MAX_MS } from '@app/constants/timeouts';

const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;
const ZOOM_RERENDER_DEFER_WHILE_GESTURE_MS = 80;
const ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS = 110;

interface IZoomRerenderBusySignal {
    operationId?: TZoomInteractionLockOperationId | null | undefined;
    reason: string;
}

interface IZoomQueueTransactionController {
    beginTransaction: (options: {
        kind: 'zoom';
        source: TPdfViewerTransactionSource;
        page?: number | null | undefined;
        range?: IPageRange | undefined;
        anchor?: NonNullable<IPdfViewerTransaction['target']>['anchor'];
    }) => IPdfViewerTransaction | null;
    advanceTransaction: (
        transactionId: number,
        state: Exclude<TPdfViewerTransactionState, 'preparing' | 'cancelled'>,
    ) => boolean;
    cancelActiveTransaction: (
        cancellation: IPdfViewerTransactionCancellation,
        transactionId?: number | undefined,
    ) => boolean;
    isTransactionCurrent: (transactionId: number) => boolean;
}

interface IPendingZoomSyncOptions extends ICurrentPageSyncOptions {transactionId?: number | undefined;}

interface IUsePdfViewerZoomRerenderQueueOptions {
    pdfDocument: Ref<PDFDocumentProxy | null>;
    isLoading: Ref<boolean>;
    viewerContainer: Ref<HTMLElement | null>;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => unknown;
    reRenderVisiblePagesAndSyncCurrentPage: (syncOptions?: ICurrentPageSyncOptions) => Promise<void>;
    buildResizeAnchorContext: () => IResizeAnchorContext;
    scheduleEndResizeTransition?: (token: number, reason: string, page: number | null) => void;
    isZoomInteractionLocked?: (() => boolean) | undefined;
    isZoomGestureSessionLocked?: (() => boolean) | undefined;
    setZoomRerenderBusy?: ((
        busy: boolean,
        signal?: IZoomRerenderBusySignal,
    ) => TZoomInteractionLockOperationId | null | undefined) | undefined;
    transactionController?: IZoomQueueTransactionController | undefined;
}

export const usePdfViewerZoomRerenderQueue = (options: IUsePdfViewerZoomRerenderQueueOptions) => {
    const {
        pdfDocument,
        isLoading,
        viewerContainer,
        summarizeViewerMetricsForLog,
        reRenderVisiblePagesAndSyncCurrentPage,
        buildResizeAnchorContext,
        scheduleEndResizeTransition,
        isZoomInteractionLocked,
        isZoomGestureSessionLocked,
        setZoomRerenderBusy,
        transactionController,
    } = options;

    let pendingZoomSyncOptions: IPendingZoomSyncOptions | null = null;
    let zoomRerenderFrameScheduled = false;
    let zoomRerenderDeferredTimer: ReturnType<typeof setTimeout> | null = null;
    let zoomRerenderQueueProcessing = false;
    let lastZoomRerenderFrameAtMs = 0;
    let zoomGestureLowResRerenderUsed = false;
    let zoomSettleCheckTimer: ReturnType<typeof setTimeout> | null = null;
    let deferredResizeSyncAfterZoom: {
        capturedAtMs: number;
        stage: string;
        syncOptions: ICurrentPageSyncOptions;
    } | null = null;
    let deferredResizeMaxTimer: ReturnType<typeof setTimeout> | null = null;
    let lastReportedZoomBusy = false;
    let activeZoomRerenderLockOperationId: TZoomInteractionLockOperationId | null = null;
    let activeZoomTransactionId: number | null = null;

    function mapZoomRerenderSourceToTransactionSource(
        source: string | null | undefined,
    ): TPdfViewerTransactionSource {
        const normalizedSource = normalizePdfRerenderSource(
            source,
            PDF_RERENDER_SOURCE.ZoomChange,
        );
        switch (normalizedSource) {
            case PDF_RERENDER_SOURCE.ZoomGestureChange:
                return 'zoom-gesture';
            case PDF_RERENDER_SOURCE.ZoomSettle:
                return 'zoom-settle';
            default:
                return 'zoom-change';
        }
    }

    function beginZoomTransaction(syncOptions: ICurrentPageSyncOptions) {
        const transaction = transactionController?.beginTransaction({
            kind: 'zoom',
            source: mapZoomRerenderSourceToTransactionSource(syncOptions.source),
            page: syncOptions.resizeAnchor?.page ?? null,
            range: syncOptions.resizeAnchor?.visibleRange,
            anchor: syncOptions.resizeAnchor ? 'center' : null,
        }) ?? null;
        activeZoomTransactionId = transaction?.id ?? activeZoomTransactionId;
        return transaction?.id;
    }

    function isZoomTransactionCurrent(syncOptions: IPendingZoomSyncOptions) {
        return syncOptions.transactionId === undefined
            || transactionController?.isTransactionCurrent(syncOptions.transactionId) !== false;
    }

    function cancelActiveZoomTransaction(reason: IPdfViewerTransactionCancellation['reason']) {
        if (activeZoomTransactionId === null) {
            return;
        }
        transactionController?.cancelActiveTransaction({
            reason,
            cancelInFlightRenders: true,
            bumpRenderVersion: reason === 'zoom',
            preserveVisualContent: true,
        }, activeZoomTransactionId);
        activeZoomTransactionId = null;
    }

    function advanceZoomTransaction(
        syncOptions: IPendingZoomSyncOptions,
        state: Exclude<TPdfViewerTransactionState, 'preparing' | 'cancelled'>,
    ) {
        if (syncOptions.transactionId === undefined) {
            return true;
        }
        const isCurrent = transactionController?.advanceTransaction(
            syncOptions.transactionId,
            state,
        ) !== false;
        if (state === 'settled' && activeZoomTransactionId === syncOptions.transactionId) {
            activeZoomTransactionId = null;
        }
        return isCurrent;
    }

    function stripZoomTransactionId(syncOptions: IPendingZoomSyncOptions): ICurrentPageSyncOptions {
        const {
            transactionId: _transactionId,
            ...currentPageSyncOptions
        } = syncOptions;
        return currentPageSyncOptions;
    }

    function isZoomRerenderBusy() {
        return zoomRerenderQueueProcessing
            || zoomRerenderFrameScheduled
            || zoomRerenderDeferredTimer !== null
            || pendingZoomSyncOptions !== null;
    }

    function notifyZoomRerenderBusy(
        busy: boolean,
        source: string,
        operationId = activeZoomRerenderLockOperationId,
    ) {
        const signaledOperationId = setZoomRerenderBusy?.(busy, {
            operationId,
            reason: source,
        });
        if (busy) {
            activeZoomRerenderLockOperationId =
                typeof signaledOperationId === 'number'
                    ? signaledOperationId
                    : operationId;
        } else {
            activeZoomRerenderLockOperationId = null;
        }
    }

    function adoptPendingZoomLockOperation(source: string) {
        if (!lastReportedZoomBusy) {
            return;
        }
        const operationId = pendingZoomSyncOptions?.zoomLockOperationId ?? null;
        if (
            operationId === null
            || operationId === activeZoomRerenderLockOperationId
        ) {
            return;
        }
        notifyZoomRerenderBusy(true, source, operationId);
    }

    function clearZoomRerenderDeferredTimer() {
        if (zoomRerenderDeferredTimer !== null) {
            clearTimeout(zoomRerenderDeferredTimer);
            zoomRerenderDeferredTimer = null;
        }
    }

    function clearZoomSettleCheckTimer() {
        if (zoomSettleCheckTimer !== null) {
            clearTimeout(zoomSettleCheckTimer);
            zoomSettleCheckTimer = null;
        }
    }

    function reportZoomBusyStateIfChanged(source: string) {
        const busy = isZoomRerenderBusy();
        if (busy === lastReportedZoomBusy) {
            return;
        }
        lastReportedZoomBusy = busy;
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-busy', ZOOM_QUEUE_LOG_THROTTLE_MS, `[zoom-queue] busy=${busy}`, {
            source,
            busy,
            frameScheduled: zoomRerenderFrameScheduled,
            queueProcessing: zoomRerenderQueueProcessing,
            hasPendingZoomSync: Boolean(pendingZoomSyncOptions),
        });
        notifyZoomRerenderBusy(
            busy,
            source,
            pendingZoomSyncOptions?.zoomLockOperationId ?? activeZoomRerenderLockOperationId,
        );
    }

    function deferZoomRerenderWhileGestureActive() {
        if (zoomRerenderDeferredTimer !== null) {
            return false;
        }
        reportZoomBusyStateIfChanged('gesture-locked-defer-scheduled');
        zoomRerenderDeferredTimer = setTimeout(() => {
            zoomRerenderDeferredTimer = null;
            reportZoomBusyStateIfChanged('gesture-locked-defer-fired');
            if (!pendingZoomSyncOptions) {
                return;
            }
            scheduleZoomRerender();
        }, ZOOM_RERENDER_DEFER_WHILE_GESTURE_MS);
        return true;
    }

    function canScheduleZoomSettleRerender() {
        return zoomGestureLowResRerenderUsed
            && !pendingZoomSyncOptions
            && Boolean(pdfDocument.value)
            && !isLoading.value;
    }

    function deferZoomSettleCheckWhileGestureLocked() {
        if (zoomSettleCheckTimer !== null) {
            return;
        }
        zoomSettleCheckTimer = setTimeout(() => {
            zoomSettleCheckTimer = null;
            scheduleZoomSettleRerenderIfNeeded();
        }, ZOOM_RERENDER_DEFER_WHILE_GESTURE_MS);
    }

    function enqueueZoomSettleRerender() {
        zoomGestureLowResRerenderUsed = false;
        const syncOptions: ICurrentPageSyncOptions = {
            source: PDF_RERENDER_SOURCE.ZoomSettle,
            stabilize: true,
            resizeAnchor: buildResizeAnchorContext(),
        };
        pendingZoomSyncOptions = {
            ...syncOptions,
            transactionId: beginZoomTransaction(syncOptions),
        };
        reportZoomBusyStateIfChanged('zoom-settle-enqueue');
        scheduleZoomRerender();
    }

    function scheduleZoomSettleRerenderIfNeeded() {
        if (!canScheduleZoomSettleRerender()) {
            return;
        }
        const gestureSessionLocked = isZoomGestureSessionLocked?.() ?? false;
        if (gestureSessionLocked) {
            deferZoomSettleCheckWhileGestureLocked();
            return;
        }

        enqueueZoomSettleRerender();
    }

    function scheduleResizeAwareRerender(
        stage: string,
        syncOptions: ICurrentPageSyncOptions = {},
    ) {
        const source = normalizePdfRerenderSource(
            syncOptions.source,
            PDF_RERENDER_SOURCE.ReRender,
        );
        if (isResizePdfRerenderSource(source) && isZoomRerenderBusy()) {
            deferredResizeSyncAfterZoom = {
                capturedAtMs: Date.now(),
                stage,
                syncOptions,
            };
            if (deferredResizeMaxTimer !== null) {
                clearTimeout(deferredResizeMaxTimer);
            }
            deferredResizeMaxTimer = setTimeout(() => {
                deferredResizeMaxTimer = null;
                const deferred = deferredResizeSyncAfterZoom;
                if (!deferred || !isDocumentReadyForZoomRerender()) {
                    return;
                }
                deferredResizeSyncAfterZoom = null;
                BrowserLogger.diagnostic('pdf-nav', '[resize-settle] bounded zoom deferral elapsed; forcing current resize demand', {
                    deferredForMs: Date.now() - deferred.capturedAtMs,
                    maxDeferredMs: PDF_RESIZE_DEFERRED_BEHIND_ZOOM_MAX_MS,
                    stage: deferred.stage,
                    zoomBusy: isZoomRerenderBusy(),
                });
                runGuardedTask(() => reRenderVisiblePagesAndSyncCurrentPage(deferred.syncOptions), {
                    category: 'user-visible-operation',
                    scope: 'pdf-viewer',
                    message: `Failed to ${deferred.stage} (bounded zoom deferral)`,
                });
            }, PDF_RESIZE_DEFERRED_BEHIND_ZOOM_MAX_MS);
            BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-defer-resize', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] deferred resize rerender while zoom busy', {
                stage,
                source,
                hasResizeAnchor: Boolean(syncOptions.resizeAnchor),
                zoomBusy: isZoomRerenderBusy(),
            });
            return;
        }
        runGuardedTask(() => reRenderVisiblePagesAndSyncCurrentPage(syncOptions), {
            category: 'user-visible-operation',
            scope: 'pdf-viewer',
            message: `Failed to ${stage}`,
        });
    }

    function cancelDeferredResizeRerender(reason: string) {
        if (deferredResizeMaxTimer !== null) {
            clearTimeout(deferredResizeMaxTimer);
            deferredResizeMaxTimer = null;
        }
        const deferred = deferredResizeSyncAfterZoom;
        deferredResizeSyncAfterZoom = null;
        if (deferredResizeMaxTimer !== null) {
            clearTimeout(deferredResizeMaxTimer);
            deferredResizeMaxTimer = null;
        }
        if (!deferred?.syncOptions.resizeAnchor) {
            return;
        }
        scheduleEndResizeTransition?.(
            deferred.syncOptions.resizeAnchor.transitionToken,
            reason,
            deferred.syncOptions.resizeAnchor.page,
        );
    }

    function flushDeferredResizeRerender(source: string) {
        if (isZoomRerenderBusy() || !deferredResizeSyncAfterZoom) {
            return;
        }
        if (!isDocumentReadyForZoomRerender()) {
            cancelDeferredResizeRerender('deferred-resize-document-not-ready');
            return;
        }
        const deferred = deferredResizeSyncAfterZoom;
        deferredResizeSyncAfterZoom = null;
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-flush-deferred-resize', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] flush deferred resize rerender', {
            source,
            deferredForMs: Date.now() - deferred.capturedAtMs,
            stage: deferred.stage,
            syncSource: normalizePdfRerenderSource(deferred.syncOptions.source),
        });
        runGuardedTask(() => reRenderVisiblePagesAndSyncCurrentPage(deferred.syncOptions), {
            category: 'user-visible-operation',
            scope: 'pdf-viewer',
            message: `Failed to ${deferred.stage} (deferred until zoom settled)`,
        });
    }

    function isDocumentReadyForZoomRerender() {
        return Boolean(pdfDocument.value) && !isLoading.value;
    }

    function clearPendingZoomSyncBecauseDocumentNotReady() {
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-clear-pending-not-ready', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] clear pending because document not ready', {
            hasDocument: Boolean(pdfDocument.value),
            isLoading: isLoading.value,
        });
        pendingZoomSyncOptions = null;
        cancelActiveZoomTransaction('zoom');
    }

    function takeNextPendingZoomSyncOptions() {
        const nextSyncOptions = pendingZoomSyncOptions;
        pendingZoomSyncOptions = null;
        return nextSyncOptions;
    }

    function logZoomQueueRun(nextSyncOptions: ICurrentPageSyncOptions) {
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-run-next-sync-option', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] run next sync option', {
            source: normalizePdfRerenderSource(nextSyncOptions.source),
            hasResizeAnchor: Boolean(nextSyncOptions.resizeAnchor),
            anchorPage: nextSyncOptions.resizeAnchor?.page ?? null,
            anchorCapturedAtMs: nextSyncOptions.resizeAnchor?.capturedAtMs ?? null,
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        });
    }

    function finishZoomRerenderQueueProcessing() {
        zoomRerenderQueueProcessing = false;
        if (pendingZoomSyncOptions) {
            BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-pending-remains', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] pending remains after processing; schedule again');
            scheduleZoomRerender();
        }
        scheduleZoomSettleRerenderIfNeeded();
        reportZoomBusyStateIfChanged('queue-end');
        flushDeferredResizeRerender('zoom-queue-drained');
    }

    async function drainPendingZoomRerendersAndFinish() {
        try {
            while (pendingZoomSyncOptions) {
                if (!isDocumentReadyForZoomRerender()) {
                    clearPendingZoomSyncBecauseDocumentNotReady();
                    break;
                }

                const nextSyncOptions = takeNextPendingZoomSyncOptions();
                if (!nextSyncOptions) {
                    continue;
                }

                logZoomQueueRun(nextSyncOptions);
                if (!isZoomTransactionCurrent(nextSyncOptions)) {
                    continue;
                }
                advanceZoomTransaction(nextSyncOptions, 'render-requested');
                await reRenderVisiblePagesAndSyncCurrentPage(stripZoomTransactionId(nextSyncOptions));
                if (!isZoomTransactionCurrent(nextSyncOptions)) {
                    continue;
                }
                advanceZoomTransaction(nextSyncOptions, 'settled');
            }
        } finally {
            finishZoomRerenderQueueProcessing();
        }
    }

    function processPendingZoomRerenderQueue() {
        if (zoomRerenderQueueProcessing) {
            BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-skip-while-busy', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] skip process while busy');
            return Promise.resolve();
        }

        zoomRerenderQueueProcessing = true;
        reportZoomBusyStateIfChanged('queue-start');
        return drainPendingZoomRerendersAndFinish();
    }

    function shouldDeferZoomRerenderDuringGesture() {
        const gestureLocked = isZoomInteractionLocked?.() ?? false;
        if (!gestureLocked) {
            lastZoomRerenderFrameAtMs = 0;
            return false;
        }

        const nowMs = Date.now();
        const elapsedSinceLastFrameMs = nowMs - lastZoomRerenderFrameAtMs;
        const shouldThrottleDuringGesture = lastZoomRerenderFrameAtMs > 0
            && elapsedSinceLastFrameMs < ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS;
        if (!shouldThrottleDuringGesture) {
            BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-allow-during-gesture', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] allow frame while gesture active', {
                throttleIntervalMs: ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS,
                elapsedSinceLastFrameMs: lastZoomRerenderFrameAtMs > 0
                    ? elapsedSinceLastFrameMs
                    : null,
            });
            return false;
        }

        const deferScheduled = deferZoomRerenderWhileGestureActive();
        if (deferScheduled) {
            BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-defer-while-gesture-active', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] defer while gesture active', {
                throttleIntervalMs: ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS,
                elapsedSinceLastFrameMs,
            });
        }
        return true;
    }

    function scheduleZoomRerenderFrame() {
        clearZoomRerenderDeferredTimer();
        if (zoomRerenderFrameScheduled) {
            BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-frame-already-scheduled', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] frame already scheduled');
            return;
        }

        zoomRerenderFrameScheduled = true;
        reportZoomBusyStateIfChanged('frame-scheduled');
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-schedule-frame', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] schedule frame');
        runGuardedTask(async () => {
            await waitForVisualFrames();
            zoomRerenderFrameScheduled = false;
            lastZoomRerenderFrameAtMs = Date.now();
            reportZoomBusyStateIfChanged('frame-fired');
            BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-frame-fired', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] frame fired');
            await processPendingZoomRerenderQueue();
        }, {
            category: 'user-visible-operation',
            scope: 'pdf-viewer',
            message: 'Failed to re-render visible pages after zoom change',
        });
    }

    function scheduleZoomRerender() {
        if (shouldDeferZoomRerenderDuringGesture()) {
            return;
        }

        scheduleZoomRerenderFrame();
    }

    function resetZoomRerenderQueueState(reason: string) {
        pendingZoomSyncOptions = null;
        cancelActiveZoomTransaction('zoom');
        cancelDeferredResizeRerender(`zoom-queue-reset:${reason}`);
        clearZoomRerenderDeferredTimer();
        clearZoomSettleCheckTimer();
        zoomGestureLowResRerenderUsed = false;
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-reset', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] reset', { reason });
        reportZoomBusyStateIfChanged(`reset:${reason}`);
    }

    function enqueueZoomSync(syncOptions: ICurrentPageSyncOptions) {
        const transactionId = beginZoomTransaction(syncOptions);
        pendingZoomSyncOptions = {
            ...syncOptions,
            transactionId,
        };
        adoptPendingZoomLockOperation('zoom-watch-adopt-operation');
        reportZoomBusyStateIfChanged('zoom-watch-enqueue');
        scheduleZoomRerender();
    }

    function markLowResZoomRerenderUsed() {
        zoomGestureLowResRerenderUsed = true;
    }

    function cleanupZoomRerenderQueue() {
        pendingZoomSyncOptions = null;
        cancelActiveZoomTransaction('disposed');
        clearZoomRerenderDeferredTimer();
        clearZoomSettleCheckTimer();
        zoomRerenderFrameScheduled = false;
        zoomRerenderQueueProcessing = false;
        lastZoomRerenderFrameAtMs = 0;
        zoomGestureLowResRerenderUsed = false;
        cancelDeferredResizeRerender('zoom-queue-cleanup');
        lastReportedZoomBusy = false;
        notifyZoomRerenderBusy(false, 'zoom-queue-cleanup');
    }

    return {
        resetZoomRerenderQueueState,
        scheduleResizeAwareRerender,
        enqueueZoomSync,
        markLowResZoomRerenderUsed,
        cleanupZoomRerenderQueue,
    };
};
