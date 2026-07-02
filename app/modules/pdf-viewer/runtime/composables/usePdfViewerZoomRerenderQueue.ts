import type { Ref } from 'vue';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type {
    ICurrentPageSyncOptions,
    IResizeAnchorContext,
} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import {
    PDF_RERENDER_SOURCE,
    isResizePdfRerenderSource,
    normalizePdfRerenderSource,
} from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import type { TZoomInteractionLockOperationId } from '@app/modules/pdf-viewer/runtime/zoom/pdfViewerZoomTypes';

const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;
const ZOOM_RERENDER_DEFER_WHILE_GESTURE_MS = 80;
const ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS = 110;

interface IZoomRerenderBusySignal {
    operationId?: TZoomInteractionLockOperationId | null | undefined;
    reason: string;
}

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
    } = options;

    let pendingZoomSyncOptions: ICurrentPageSyncOptions | null = null;
    let zoomRerenderFrameScheduled = false;
    let zoomRerenderDeferredTimer: ReturnType<typeof setTimeout> | null = null;
    let zoomRerenderQueueProcessing = false;
    let lastZoomRerenderFrameAtMs = 0;
    let zoomGestureLowResRerenderUsed = false;
    let zoomSettleCheckTimer: ReturnType<typeof setTimeout> | null = null;
    let deferredResizeSyncAfterZoom: {
        stage: string;
        syncOptions: ICurrentPageSyncOptions;
    } | null = null;
    let lastReportedZoomBusy = false;
    let activeZoomRerenderLockOperationId: TZoomInteractionLockOperationId | null = null;

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
        pendingZoomSyncOptions = {
            source: PDF_RERENDER_SOURCE.ZoomSettle,
            stabilize: true,
            resizeAnchor: buildResizeAnchorContext(),
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
                stage,
                syncOptions,
            };
            BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-defer-resize', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] deferred resize rerender while zoom busy', {
                stage,
                source,
                hasResizeAnchor: Boolean(syncOptions.resizeAnchor),
                zoomBusy: isZoomRerenderBusy(),
            });
            return;
        }
        runGuardedTask(() => reRenderVisiblePagesAndSyncCurrentPage(syncOptions), {
            scope: 'pdf-viewer',
            message: `Failed to ${stage}`,
        });
    }

    function cancelDeferredResizeRerender(reason: string) {
        const deferred = deferredResizeSyncAfterZoom;
        deferredResizeSyncAfterZoom = null;
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
            stage: deferred.stage,
            syncSource: normalizePdfRerenderSource(deferred.syncOptions.source),
        });
        runGuardedTask(() => reRenderVisiblePagesAndSyncCurrentPage(deferred.syncOptions), {
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
                await reRenderVisiblePagesAndSyncCurrentPage(nextSyncOptions);
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
        cancelDeferredResizeRerender(`zoom-queue-reset:${reason}`);
        clearZoomRerenderDeferredTimer();
        clearZoomSettleCheckTimer();
        zoomGestureLowResRerenderUsed = false;
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-queue-reset', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] reset', { reason });
        reportZoomBusyStateIfChanged(`reset:${reason}`);
    }

    function enqueueZoomSync(syncOptions: ICurrentPageSyncOptions) {
        pendingZoomSyncOptions = syncOptions;
        adoptPendingZoomLockOperation('zoom-watch-adopt-operation');
        reportZoomBusyStateIfChanged('zoom-watch-enqueue');
        scheduleZoomRerender();
    }

    function markLowResZoomRerenderUsed() {
        zoomGestureLowResRerenderUsed = true;
    }

    function cleanupZoomRerenderQueue() {
        pendingZoomSyncOptions = null;
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
