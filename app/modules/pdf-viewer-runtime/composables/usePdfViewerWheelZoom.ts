import type {
    ComputedRef,
    Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import {
    captureScrollSnapshot,
    restoreScrollFromSnapshot,
} from '@app/composables/pdf/pdfPageRenderPipeline';
import { summarizeViewerMetrics } from '@app/composables/pdf/pdfViewerMetrics';
import { ZOOM } from '@app/constants/pdf-layout';
import type {
    TPdfSource,
    TZoomMode,
} from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browser-logger';
import type { IZoomVirtualizationFreeze } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerVirtualization';
import {
    WHEEL_DETAIL_LOG_THROTTLE_MS,
    WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS,
    WHEEL_ZOOM_GESTURE_GRACE_MS,
    WHEEL_ZOOM_SESSION_IDLE_MS,
    WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS,
} from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerWheelZoom.constants';
import { usePdfViewerWheelZoomSession } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerWheelZoomSession';

const WHEEL_ZOOM_SENSITIVITY = 0.0016;
const WHEEL_LINE_DELTA_PX = 16;
const WHEEL_DISPATCH_LOG_THROTTLE_MS = 420;
const WHEEL_SCROLL_LOG_THROTTLE_MS = 420;

interface IViewerRange {
    start: number;
    end: number;
}

interface IWheelEmit {
    (event: 'update:zoomMode', mode: TZoomMode): void;
    (event: 'update:effectiveZoom', value: number): void;
    (event: 'update:zoom', value: number): void;
}

interface IUsePdfViewerWheelZoomOptions {
    viewerContainer: Ref<HTMLElement | null>;
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    zoom: ComputedRef<number>;
    zoomMode: ComputedRef<TZoomMode>;
    effectiveScale: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<IViewerRange>;
    virtualizedContinuousMode: Ref<boolean>;
    virtualWindowStart: Ref<number>;
    virtualWindowEnd: Ref<number>;
    topVirtualSpacerStyle: Ref<Record<string, string> | null>;
    bottomVirtualSpacerStyle: Ref<Record<string, string> | null>;
    zoomVirtualizationFreeze: Ref<IZoomVirtualizationFreeze | null>;
    singlePageScroll: {
        suppressSnapFor: (ms: number) => void;
        handleWheel: (event: WheelEvent) => void;
        handleScroll: () => void;
    };
    cancelPendingSearchScroll: () => void;
    isSnipActive: () => boolean;
    emit: IWheelEmit;
}

export function usePdfViewerWheelZoom(options: IUsePdfViewerWheelZoomOptions) {
    const {
        viewerContainer,
        src,
        isLoading,
        zoom,
        zoomMode,
        effectiveScale,
        currentPage,
        visibleRange,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        zoomVirtualizationFreeze,
        singlePageScroll,
        cancelPendingSearchScroll,
        isSnipActive,
        emit,
    } = options;

    let zoomDebugWheelEventId = 0;
    let lastViewerScrollTop = 0;
    let lastViewerScrollLeft = 0;
    let lastModifierWheelZoomAtMs = 0;
    let lastModifierWheelZoomEventId = 0;

    function summarizeViewerStateForLog() {
        return summarizeViewerMetrics(viewerContainer.value);
    }
    const {
        pendingZoomViewportAnchor,
        zoomSnapSuppressed,
        pendingImmediateZoomRestoreIntent,
        getActiveWheelZoomSession,
        ensureWheelZoomSession,
        markExpectedZoomScroll,
        isZoomInteractionLocked,
        setZoomRerenderBusy,
        consumeZoomViewportAnchor,
        cleanupWheelZoomSession,
        getIsZoomRerenderBusyFromCore,
        getZoomRerenderBusyLockUntilMs,
        getExpectedZoomScrollUntilMs,
    } = usePdfViewerWheelZoomSession({
        viewerContainer,
        effectiveScale,
        currentPage,
        visibleRange,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        zoomVirtualizationFreeze,
        summarizeViewerStateForLog,
    });

    function normalizeWheelZoomDelta(event: WheelEvent, container: HTMLElement) {
        if (event.deltaMode === 1) {
            return event.deltaY * WHEEL_LINE_DELTA_PX;
        }
        if (event.deltaMode === 2) {
            return event.deltaY * Math.max(container.clientHeight, 1);
        }
        return event.deltaY;
    }

    function clampZoomLevel(level: number) {
        return clamp(level, ZOOM.MIN, ZOOM.MAX);
    }

    function resolveZoomBaselineScale() {
        if (!Number.isFinite(zoom.value) || Math.abs(zoom.value) < 0.0001) {
            return 1;
        }
        const baseline = effectiveScale.value / zoom.value;
        if (!Number.isFinite(baseline) || baseline <= 0) {
            return 1;
        }
        return baseline;
    }

    function summarizeWheelEventForDebug(event: WheelEvent) {
        return {
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            deltaMode: event.deltaMode,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaZ: event.deltaZ,
            cancelable: event.cancelable,
            defaultPrevented: event.defaultPrevented,
        };
    }

    function handleViewerModifierWheelZoom(event: WheelEvent) {
        const nowMs = Date.now();
        const debugId = ++zoomDebugWheelEventId;
        const activeSession = getActiveWheelZoomSession(nowMs);
        const isContinuationPacket = Boolean(
            activeSession
            && nowMs - activeSession.lastPacketAtMs <= WHEEL_ZOOM_GESTURE_GRACE_MS,
        );
        const hasModifierZoomSignal = event.ctrlKey
            || event.metaKey
            || Math.abs(event.deltaZ) > Number.EPSILON;
        const shouldTreatAsZoomSignal = hasModifierZoomSignal || isContinuationPacket;
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-zoom-received', WHEEL_DETAIL_LOG_THROTTLE_MS, `[wheel-zoom] received id=${debugId}`, {
            id: debugId,
            hasModifierZoomSignal,
            shouldTreatAsZoomSignal,
            isContinuationPacket,
            activeSessionId: activeSession?.id ?? null,
            viewer: summarizeViewerStateForLog(),
            wheel: summarizeWheelEventForDebug(event),
        });
        if (!shouldTreatAsZoomSignal) {
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-no-modifier',
                WHEEL_DETAIL_LOG_THROTTLE_MS,
                `[wheel-zoom] ignored id=${debugId} reason=no-zoom-signal`,
            );
            return false;
        }

        lastModifierWheelZoomAtMs = nowMs;
        lastModifierWheelZoomEventId = debugId;
        markExpectedZoomScroll(WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS);

        event.preventDefault();
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'wheel-zoom-prevent-default',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            `[wheel-zoom] prevent-default id=${debugId}`,
            {
                id: debugId,
                cancelable: event.cancelable,
                defaultPrevented: event.defaultPrevented,
            },
        );
        const container = viewerContainer.value;
        if (!container || !src.value || isLoading.value) {
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-not-ready',
                WHEEL_DETAIL_LOG_THROTTLE_MS,
                `[wheel-zoom] ignored id=${debugId} reason=viewer-not-ready`,
                {
                    id: debugId,
                    hasContainer: Boolean(container),
                    hasSrc: Boolean(src.value),
                    isLoading: isLoading.value,
                    viewer: summarizeViewerStateForLog(),
                },
            );
            return true;
        }

        const containerRect = container.getBoundingClientRect();
        const eventAnchorX = clamp(
            event.clientX - containerRect.left,
            0,
            Math.max(container.clientWidth, 0),
        );
        const eventAnchorY = clamp(
            event.clientY - containerRect.top,
            0,
            Math.max(container.clientHeight, 0),
        );
        const {
            session,
            reused: reusedGestureAnchor,
        } = ensureWheelZoomSession(nowMs, eventAnchorX, eventAnchorY, debugId);
        session.packetCount += 1;
        const anchorX = session.anchorX;
        const anchorY = session.anchorY;

        let delta = normalizeWheelZoomDelta(event, container);
        if (Math.abs(delta) < Number.EPSILON && Math.abs(event.deltaZ) > Number.EPSILON) {
            delta = event.deltaMode === 1
                ? event.deltaZ * WHEEL_LINE_DELTA_PX
                : event.deltaMode === 2
                    ? event.deltaZ * Math.max(container.clientHeight, 1)
                    : event.deltaZ;
        }
        if (Math.abs(delta) < Number.EPSILON) {
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-zero-delta',
                WHEEL_DETAIL_LOG_THROTTLE_MS,
                `[wheel-zoom] ignored id=${debugId} reason=zero-delta`,
                {
                    id: debugId,
                    wheel: summarizeWheelEventForDebug(event),
                },
            );
            return true;
        }

        session.cumulativeDelta += delta;
        const zoomFactor = Math.exp(-session.cumulativeDelta * WHEEL_ZOOM_SENSITIVITY);
        if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-invalid-factor',
                WHEEL_DETAIL_LOG_THROTTLE_MS,
                `[wheel-zoom] ignored id=${debugId} reason=invalid-factor`,
                {
                    id: debugId,
                    deltaCumulative: session.cumulativeDelta,
                    zoomFactor,
                    sessionId: session.id,
                },
            );
            return true;
        }

        const nextEffectiveZoom = clampZoomLevel(session.startZoom * zoomFactor);
        const previousEmittedZoom = session.lastEmittedZoom;
        if (Math.abs(nextEffectiveZoom - previousEmittedZoom) < 0.001) {
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-no-change',
                WHEEL_DETAIL_LOG_THROTTLE_MS,
                `[wheel-zoom] ignored id=${debugId} reason=no-zoom-change`,
                {
                    id: debugId,
                    sessionId: session.id,
                    currentZoomMultiplier: zoom.value,
                    currentEffectiveZoom: effectiveScale.value,
                    previousEmittedZoom,
                    nextEffectiveZoom,
                    delta,
                    zoomFactor,
                    cumulativeDelta: session.cumulativeDelta,
                },
            );
            return true;
        }
        session.lastEmittedZoom = nextEffectiveZoom;
        session.lastPacketAtMs = nowMs;
        session.lockUntilMs = nowMs + WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS;
        session.emittedCount += 1;
        const baselineScale = resolveZoomBaselineScale();
        const nextZoom = clampZoomLevel(nextEffectiveZoom / baselineScale);
        const snapshotForImmediateRestore = captureScrollSnapshot(container, {
            anchorViewportX: anchorX,
            anchorViewportY: anchorY,
        });
        if (snapshotForImmediateRestore) {
            pendingImmediateZoomRestoreIntent.value = {
                id: debugId,
                sessionId: session.id,
                snapshot: snapshotForImmediateRestore,
                capturedAtMs: nowMs,
            };
        }

        pendingZoomViewportAnchor.value = {
            id: debugId,
            sessionId: session.id,
            x: anchorX,
            y: anchorY,
            capturedAtMs: nowMs,
        };
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-zoom-emit', WHEEL_DETAIL_LOG_THROTTLE_MS, `[wheel-zoom] emit id=${debugId}`, {
            id: debugId,
            sessionId: session.id,
            gestureAnchorReused: reusedGestureAnchor,
            sessionStartZoom: session.startZoom,
            sessionCumulativeDelta: session.cumulativeDelta,
            eventAnchorX,
            eventAnchorY,
            delta,
            zoomFactor,
            currentZoomMultiplier: zoom.value,
            currentEffectiveZoom: effectiveScale.value,
            baselineScale,
            previousEmittedZoom,
            nextEffectiveZoom,
            nextZoom,
            anchor: pendingZoomViewportAnchor.value,
            viewerBeforeEmit: summarizeViewerStateForLog(),
            wheel: summarizeWheelEventForDebug(event),
        });

        if (zoomMode.value !== 'custom') {
            emit('update:zoomMode', 'custom');
        }
        emit('update:effectiveZoom', nextEffectiveZoom);
        emit('update:zoom', nextZoom);
        markExpectedZoomScroll(WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS);
        return true;
    }

    function handleViewerWheel(event: WheelEvent) {
        const nowMs = Date.now();
        const recentZoomAnchor = pendingZoomViewportAnchor.value;
        const recentZoomAgeMs = recentZoomAnchor
            ? nowMs - recentZoomAnchor.capturedAtMs
            : null;
        const modifierZoomAgeMs = lastModifierWheelZoomAtMs > 0
            ? nowMs - lastModifierWheelZoomAtMs
            : null;
        const isWithinModifierZoomGraceWindow = modifierZoomAgeMs !== null
            && modifierZoomAgeMs <= WHEEL_ZOOM_GESTURE_GRACE_MS;
        const activeSession = getActiveWheelZoomSession(nowMs);
        const zoomInteractionLocked = isZoomInteractionLocked(nowMs);
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-dispatch', WHEEL_DISPATCH_LOG_THROTTLE_MS, '[wheel] dispatch', {
            recentZoomIntentId: recentZoomAnchor?.id ?? null,
            recentZoomAgeMs,
            recentModifierZoomEventId: lastModifierWheelZoomEventId || null,
            modifierZoomAgeMs,
            withinModifierZoomGraceWindow: isWithinModifierZoomGraceWindow,
            activeSessionId: activeSession?.id ?? null,
            zoomInteractionLocked,
            coreZoomRerenderBusy: getIsZoomRerenderBusyFromCore(),
            coreZoomRerenderLockAgeMs: getZoomRerenderBusyLockUntilMs() > nowMs
                ? getZoomRerenderBusyLockUntilMs() - nowMs
                : 0,
            viewer: summarizeViewerStateForLog(),
            wheel: summarizeWheelEventForDebug(event),
        });
        if (isSnipActive()) {
            event.preventDefault();
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-blocked-snip', WHEEL_DETAIL_LOG_THROTTLE_MS, '[wheel] blocked by snip mode');
            return;
        }

        if (handleViewerModifierWheelZoom(event)) {
            singlePageScroll.suppressSnapFor(
                Math.max(
                    WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS,
                    WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS,
                ),
            );
            cancelPendingSearchScroll();
            return;
        }

        if (zoomInteractionLocked || isWithinModifierZoomGraceWindow) {
            event.preventDefault();
            singlePageScroll.suppressSnapFor(
                Math.max(
                    WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS,
                    WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS,
                ),
            );
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'wheel-suppressed-non-modifier',
                WHEEL_DETAIL_LOG_THROTTLE_MS,
                '[wheel] suppressed non-modifier packet during active zoom lock',
                {
                    zoomInteractionLocked,
                    graceWindowMs: WHEEL_ZOOM_GESTURE_GRACE_MS,
                    recentModifierZoomEventId: lastModifierWheelZoomEventId || null,
                    modifierZoomAgeMs,
                    activeSessionId: activeSession?.id ?? null,
                    viewer: summarizeViewerStateForLog(),
                    wheel: summarizeWheelEventForDebug(event),
                },
            );
            cancelPendingSearchScroll();
            return;
        }

        cancelPendingSearchScroll();
        singlePageScroll.handleWheel(event);
    }

    function handleViewerScroll(event: Event) {
        const nowMs = Date.now();
        const container = viewerContainer.value;
        const currentTop = container ? Math.round(container.scrollTop) : null;
        const currentLeft = container ? Math.round(container.scrollLeft) : null;
        const deltaTop = currentTop === null ? null : currentTop - lastViewerScrollTop;
        const deltaLeft = currentLeft === null ? null : currentLeft - lastViewerScrollLeft;

        if (currentTop !== null) {
            lastViewerScrollTop = currentTop;
        }
        if (currentLeft !== null) {
            lastViewerScrollLeft = currentLeft;
        }

        const activeZoomIntent = pendingZoomViewportAnchor.value;
        const activeSession = getActiveWheelZoomSession(nowMs);
        const zoomInteractionLocked = isZoomInteractionLocked(nowMs);
        const zoomScrollExpected = nowMs <= getExpectedZoomScrollUntilMs();
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'scroll-viewer', WHEEL_SCROLL_LOG_THROTTLE_MS, '[scroll] viewer', {
            type: event.type,
            deltaTop,
            deltaLeft,
            viewer: summarizeViewerStateForLog(),
            activeZoomIntentId: activeZoomIntent?.id ?? null,
            activeZoomIntentAgeMs: activeZoomIntent
                ? nowMs - activeZoomIntent.capturedAtMs
                : null,
            activeSessionId: activeSession?.id ?? null,
            zoomInteractionLocked,
            zoomScrollExpected,
        });
        if (
            zoomInteractionLocked
            && !zoomScrollExpected
            && (
                (typeof deltaTop === 'number' && Math.abs(deltaTop) >= 10)
                || (typeof deltaLeft === 'number' && Math.abs(deltaLeft) >= 10)
            )
        ) {
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'scroll-drift-unexpected-during-zoom-lock',
                WHEEL_SCROLL_LOG_THROTTLE_MS,
                '[scroll-drift] unexpected scroll delta during active zoom lock',
                {
                    deltaTop,
                    deltaLeft,
                    activeSessionId: activeSession?.id ?? null,
                    recentZoomIntentId: activeZoomIntent?.id ?? null,
                    recentZoomIntentAgeMs: activeZoomIntent
                        ? nowMs - activeZoomIntent.capturedAtMs
                        : null,
                    expectedZoomScrollUntilMs: getExpectedZoomScrollUntilMs(),
                    viewer: summarizeViewerStateForLog(),
                },
            );
        }

        if (zoomInteractionLocked || zoomScrollExpected) {
            singlePageScroll.suppressSnapFor(
                Math.max(
                    WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS,
                    WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS,
                ),
            );
        }

        singlePageScroll.handleScroll();
    }

    watch(
        () => zoom.value,
        (nextZoom, previousZoom) => {
            const pendingIntent = pendingImmediateZoomRestoreIntent.value;
            if (!pendingIntent) {
                return;
            }
            const container = viewerContainer.value;
            if (!container) {
                pendingImmediateZoomRestoreIntent.value = null;
                return;
            }

            restoreScrollFromSnapshot(container, pendingIntent.snapshot, {
                restoreHorizontal: true,
                restoreVertical: true,
                preferPageAnchor: true,
                allowVerticalRatioFallback: false,
            });
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-zoom-immediate-restore', WHEEL_DETAIL_LOG_THROTTLE_MS, `[wheel-zoom] immediate-restore id=${pendingIntent.id}`, {
                id: pendingIntent.id,
                sessionId: pendingIntent.sessionId,
                capturedAtMs: pendingIntent.capturedAtMs,
                previousZoom,
                nextZoom,
                viewer: summarizeViewerStateForLog(),
            });
            pendingImmediateZoomRestoreIntent.value = null;
        },
        { flush: 'post' },
    );

    onScopeDispose(() => {
        cleanupWheelZoomSession();
    });

    return {
        zoomSnapSuppressed,
        handleViewerWheel,
        handleViewerScroll,
        consumeZoomViewportAnchor,
        isZoomInteractionLocked,
        setZoomRerenderBusy,
    };
}
