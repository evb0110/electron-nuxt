import type { Ref } from 'vue';
import { waitForVisualFrames } from '@app/utils/async-helpers';
import { BrowserLogger } from '@app/utils/browser-logger';
import { runGuardedTask } from '@app/utils/async-guard';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type {
    ICurrentPageSyncOptions,
    IResizeAnchorContext,
} from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerCurrentPageSync';
import { isResizeRerenderSource } from '@app/modules/pdf-viewer-runtime/rerenderStrategy';

const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;
const ZOOM_RERENDER_DEFER_WHILE_GESTURE_MS = 80;
const ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS = 110;

interface IUsePdfViewerZoomRerenderQueueOptions {
    pdfDocument: Ref<PDFDocumentProxy | null>;
    isLoading: Ref<boolean>;
    viewerContainer: Ref<HTMLElement | null>;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => unknown;
    reRenderVisiblePagesAndSyncCurrentPage: (syncOptions?: ICurrentPageSyncOptions) => Promise<void>;
    buildResizeAnchorContext: () => IResizeAnchorContext;
    isZoomInteractionLocked?: () => boolean;
    isZoomGestureSessionLocked?: () => boolean;
    setZoomRerenderBusy?: (busy: boolean) => void;
}

export function usePdfViewerZoomRerenderQueue(options: IUsePdfViewerZoomRerenderQueueOptions) {
    const {
        pdfDocument,
        isLoading,
        viewerContainer,
        summarizeViewerMetricsForLog,
        reRenderVisiblePagesAndSyncCurrentPage,
        buildResizeAnchorContext,
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

    function isZoomRerenderBusy() {
        return zoomRerenderQueueProcessing
            || zoomRerenderFrameScheduled
            || zoomRerenderDeferredTimer !== null
            || pendingZoomSyncOptions !== null;
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
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-busy', ZOOM_QUEUE_LOG_THROTTLE_MS, `[zoom-queue] busy=${busy}`, {
            source,
            busy,
            frameScheduled: zoomRerenderFrameScheduled,
            queueProcessing: zoomRerenderQueueProcessing,
            hasPendingZoomSync: Boolean(pendingZoomSyncOptions),
        });
        setZoomRerenderBusy?.(busy);
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

    function scheduleZoomSettleRerenderIfNeeded() {
        if (!zoomGestureLowResRerenderUsed || pendingZoomSyncOptions) {
            return;
        }
        if (!pdfDocument.value || isLoading.value) {
            return;
        }
        const gestureSessionLocked = isZoomGestureSessionLocked?.() ?? false;
        if (gestureSessionLocked) {
            if (zoomSettleCheckTimer !== null) {
                return;
            }
            zoomSettleCheckTimer = setTimeout(() => {
                zoomSettleCheckTimer = null;
                scheduleZoomSettleRerenderIfNeeded();
            }, ZOOM_RERENDER_DEFER_WHILE_GESTURE_MS);
            return;
        }

        zoomGestureLowResRerenderUsed = false;
        pendingZoomSyncOptions = {
            source: 'zoom-settle',
            stabilize: true,
            resizeAnchor: buildResizeAnchorContext(),
        };
        reportZoomBusyStateIfChanged('zoom-settle-enqueue');
        scheduleZoomRerender();
    }

    function scheduleResizeAwareRerender(
        stage: string,
        syncOptions: ICurrentPageSyncOptions = {},
    ) {
        const source = syncOptions.source ?? 're-render';
        if (isResizeRerenderSource(source) && isZoomRerenderBusy()) {
            deferredResizeSyncAfterZoom = {
                stage,
                syncOptions,
            };
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-defer-resize', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] deferred resize rerender while zoom busy', {
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

    function flushDeferredResizeRerender(source: string) {
        if (isZoomRerenderBusy() || !deferredResizeSyncAfterZoom) {
            return;
        }
        const deferred = deferredResizeSyncAfterZoom;
        deferredResizeSyncAfterZoom = null;
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-flush-deferred-resize', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] flush deferred resize rerender', {
            source,
            stage: deferred.stage,
            syncSource: deferred.syncOptions.source ?? 'unknown',
        });
        runGuardedTask(() => reRenderVisiblePagesAndSyncCurrentPage(deferred.syncOptions), {
            scope: 'pdf-viewer',
            message: `Failed to ${deferred.stage} (deferred until zoom settled)`,
        });
    }

    async function processPendingZoomRerenderQueue() {
        if (zoomRerenderQueueProcessing) {
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-skip-while-busy', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] skip process while busy');
            return;
        }

        zoomRerenderQueueProcessing = true;
        reportZoomBusyStateIfChanged('queue-start');
        try {
            while (pendingZoomSyncOptions) {
                if (!pdfDocument.value || isLoading.value) {
                    BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-clear-pending-not-ready', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] clear pending because document not ready', {
                        hasDocument: Boolean(pdfDocument.value),
                        isLoading: isLoading.value,
                    });
                    pendingZoomSyncOptions = null;
                    break;
                }

                const nextSyncOptions = pendingZoomSyncOptions;
                pendingZoomSyncOptions = null;
                BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-run-next-sync-option', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] run next sync option', {
                    source: nextSyncOptions.source ?? 'unknown',
                    hasResizeAnchor: Boolean(nextSyncOptions.resizeAnchor),
                    anchorPage: nextSyncOptions.resizeAnchor?.page ?? null,
                    anchorCapturedAtMs: nextSyncOptions.resizeAnchor?.capturedAtMs ?? null,
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                });
                await reRenderVisiblePagesAndSyncCurrentPage(nextSyncOptions);
            }
        } finally {
            zoomRerenderQueueProcessing = false;
            if (pendingZoomSyncOptions) {
                BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-pending-remains', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] pending remains after processing; schedule again');
                scheduleZoomRerender();
            }
            scheduleZoomSettleRerenderIfNeeded();
            reportZoomBusyStateIfChanged('queue-end');
            flushDeferredResizeRerender('zoom-queue-drained');
        }
    }

    function scheduleZoomRerender() {
        const gestureLocked = isZoomInteractionLocked?.() ?? false;
        if (gestureLocked) {
            const nowMs = Date.now();
            const elapsedSinceLastFrameMs = nowMs - lastZoomRerenderFrameAtMs;
            const shouldThrottleDuringGesture = lastZoomRerenderFrameAtMs > 0
                && elapsedSinceLastFrameMs < ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS;
            if (shouldThrottleDuringGesture) {
                const deferScheduled = deferZoomRerenderWhileGestureActive();
                if (deferScheduled) {
                    BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-defer-while-gesture-active', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] defer while gesture active', {
                        throttleIntervalMs: ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS,
                        elapsedSinceLastFrameMs,
                    });
                }
                return;
            }
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-allow-during-gesture', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] allow frame while gesture active', {
                throttleIntervalMs: ZOOM_RERENDER_DURING_GESTURE_MIN_INTERVAL_MS,
                elapsedSinceLastFrameMs: lastZoomRerenderFrameAtMs > 0
                    ? elapsedSinceLastFrameMs
                    : null,
            });
        } else {
            lastZoomRerenderFrameAtMs = 0;
        }

        clearZoomRerenderDeferredTimer();
        if (zoomRerenderFrameScheduled) {
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-frame-already-scheduled', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] frame already scheduled');
            return;
        }

        zoomRerenderFrameScheduled = true;
        reportZoomBusyStateIfChanged('frame-scheduled');
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-schedule-frame', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] schedule frame');
        runGuardedTask(async () => {
            await waitForVisualFrames();
            zoomRerenderFrameScheduled = false;
            lastZoomRerenderFrameAtMs = Date.now();
            reportZoomBusyStateIfChanged('frame-fired');
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-frame-fired', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] frame fired');
            await processPendingZoomRerenderQueue();
        }, {
            scope: 'pdf-viewer',
            message: 'Failed to re-render visible pages after zoom change',
        });
    }

    function resetZoomRerenderQueueState(reason: string) {
        pendingZoomSyncOptions = null;
        clearZoomRerenderDeferredTimer();
        clearZoomSettleCheckTimer();
        zoomGestureLowResRerenderUsed = false;
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'zoom-queue-reset', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-queue] reset', { reason });
        reportZoomBusyStateIfChanged(`reset:${reason}`);
    }

    function enqueueZoomSync(syncOptions: ICurrentPageSyncOptions) {
        pendingZoomSyncOptions = syncOptions;
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
        deferredResizeSyncAfterZoom = null;
        lastReportedZoomBusy = false;
        setZoomRerenderBusy?.(false);
    }

    return {
        resetZoomRerenderQueueState,
        scheduleResizeAwareRerender,
        enqueueZoomSync,
        markLowResZoomRerenderUsed,
        cleanupZoomRerenderQueue,
    };
}
