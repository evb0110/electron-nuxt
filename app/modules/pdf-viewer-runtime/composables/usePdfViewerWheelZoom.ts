import type {
    ComputedRef,
    Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import {
    captureScrollSnapshot,
    restoreScrollFromSnapshot,
} from '@app/composables/pdf/pdfPageRenderPipeline';
import { ZOOM } from '@app/constants/pdf-layout';
import type {
    IScrollSnapshot,
    TPdfSource,
    TZoomMode,
} from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browser-logger';
import type { IZoomVirtualizationFreeze } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerVirtualization';

const WHEEL_ZOOM_SENSITIVITY = 0.0016;
const WHEEL_LINE_DELTA_PX = 16;
const ZOOM_VIEWPORT_ANCHOR_MAX_AGE_MS = 240;
const WHEEL_ZOOM_GESTURE_GRACE_MS = 180;
const WHEEL_ZOOM_SESSION_IDLE_MS = 220;
const WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS = 260;
const WHEEL_DISPATCH_LOG_THROTTLE_MS = 420;
const WHEEL_SCROLL_LOG_THROTTLE_MS = 420;
const WHEEL_DETAIL_LOG_THROTTLE_MS = 320;
const WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS = 1400;

interface IZoomViewportAnchorIntent {
    id: number;
    sessionId: number;
    x: number;
    y: number;
    capturedAtMs: number;
}

interface IWheelZoomSession {
    id: number;
    anchorX: number;
    anchorY: number;
    startZoom: number;
    cumulativeDelta: number;
    lastEmittedZoom: number;
    startedAtMs: number;
    lastPacketAtMs: number;
    lockUntilMs: number;
    lastEventId: number;
    packetCount: number;
    emittedCount: number;
    startScrollTop: number | null;
    startScrollLeft: number | null;
}

interface IImmediateZoomRestoreIntent {
    id: number;
    sessionId: number;
    snapshot: IScrollSnapshot;
    capturedAtMs: number;
}

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

    const pendingZoomViewportAnchor = ref<IZoomViewportAnchorIntent | null>(null);
    const zoomSnapSuppressed = ref(false);
    let zoomDebugWheelEventId = 0;
    let lastViewerScrollTop = 0;
    let lastViewerScrollLeft = 0;
    let lastModifierWheelZoomAtMs = 0;
    let lastModifierWheelZoomEventId = 0;
    let wheelZoomSessionId = 0;
    let activeWheelZoomSession: IWheelZoomSession | null = null;
    let wheelZoomSessionIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let isZoomRerenderBusyFromCore = false;
    let zoomRerenderBusyLockUntilMs = 0;
    let expectedZoomScrollUntilMs = 0;
    let zoomSnapSuppressedTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingImmediateZoomRestoreIntent: IImmediateZoomRestoreIntent | null = null;

    function summarizeViewerStateForLog() {
        const container = viewerContainer.value;
        if (!container) {
            return null;
        }
        return {
            scrollTop: Math.round(container.scrollTop),
            scrollLeft: Math.round(container.scrollLeft),
            clientWidth: Math.round(container.clientWidth),
            clientHeight: Math.round(container.clientHeight),
            scrollWidth: Math.round(container.scrollWidth),
            scrollHeight: Math.round(container.scrollHeight),
        };
    }

    function captureZoomVirtualizationFreeze(sessionId: number | null, reason: string) {
        if (!virtualizedContinuousMode.value) {
            zoomVirtualizationFreeze.value = null;
            return;
        }

        const topSpacerHeight = Number.parseFloat(topVirtualSpacerStyle.value?.height ?? '0');
        const bottomSpacerHeight = Number.parseFloat(bottomVirtualSpacerStyle.value?.height ?? '0');

        zoomVirtualizationFreeze.value = {
            sessionId,
            capturedAtMs: Date.now(),
            windowStart: virtualWindowStart.value,
            windowEnd: virtualWindowEnd.value,
            topSpacerHeight: Number.isFinite(topSpacerHeight) ? Math.max(0, topSpacerHeight) : 0,
            bottomSpacerHeight: Number.isFinite(bottomSpacerHeight) ? Math.max(0, bottomSpacerHeight) : 0,
        };

        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'virtualization-freeze-capture',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            `[zoom-virtualization] capture reason=${reason}`,
            {
                reason,
                freeze: zoomVirtualizationFreeze.value,
                currentPage: currentPage.value,
                visibleRange: {
                    start: visibleRange.value.start,
                    end: visibleRange.value.end,
                },
                viewer: summarizeViewerStateForLog(),
            },
        );
    }

    function releaseZoomVirtualizationFreeze(reason: string) {
        if (!zoomVirtualizationFreeze.value) {
            return;
        }

        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'virtualization-freeze-release',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            `[zoom-virtualization] release reason=${reason}`,
            {
                reason,
                freeze: zoomVirtualizationFreeze.value,
                viewer: summarizeViewerStateForLog(),
            },
        );
        zoomVirtualizationFreeze.value = null;
    }

    function shouldHoldZoomVirtualizationFreeze(nowMs = Date.now()) {
        if (!virtualizedContinuousMode.value) {
            return false;
        }

        if (isZoomRerenderBusyFromCore || zoomSnapSuppressed.value || nowMs <= expectedZoomScrollUntilMs) {
            return true;
        }

        return Boolean(getActiveWheelZoomSession(nowMs));
    }

    function maybeReleaseZoomVirtualizationFreeze(reason: string) {
        if (shouldHoldZoomVirtualizationFreeze()) {
            return;
        }
        releaseZoomVirtualizationFreeze(reason);
    }

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

    function clearWheelZoomSessionIdleTimer() {
        if (wheelZoomSessionIdleTimer !== null) {
            clearTimeout(wheelZoomSessionIdleTimer);
            wheelZoomSessionIdleTimer = null;
        }
    }

    function clearZoomSnapSuppressedTimer() {
        if (zoomSnapSuppressedTimer !== null) {
            clearTimeout(zoomSnapSuppressedTimer);
            zoomSnapSuppressedTimer = null;
        }
    }

    function scheduleZoomSnapSuppressedRelease() {
        clearZoomSnapSuppressedTimer();
        const delayMs = expectedZoomScrollUntilMs - Date.now();
        if (delayMs <= 0) {
            zoomSnapSuppressed.value = false;
            maybeReleaseZoomVirtualizationFreeze('expected-scroll-window-expired');
            return;
        }
        zoomSnapSuppressedTimer = setTimeout(() => {
            zoomSnapSuppressedTimer = null;
            if (Date.now() <= expectedZoomScrollUntilMs) {
                scheduleZoomSnapSuppressedRelease();
                return;
            }
            zoomSnapSuppressed.value = false;
            maybeReleaseZoomVirtualizationFreeze('expected-scroll-window-expired');
        }, delayMs + 32);
    }

    function markExpectedZoomScroll(ms: number) {
        expectedZoomScrollUntilMs = Math.max(
            expectedZoomScrollUntilMs,
            Date.now() + Math.max(0, ms),
        );
        zoomSnapSuppressed.value = true;
        captureZoomVirtualizationFreeze(
            activeWheelZoomSession?.id ?? null,
            'expected-scroll-window',
        );
        scheduleZoomSnapSuppressedRelease();
    }

    function endWheelZoomSession(reason: string) {
        clearWheelZoomSessionIdleTimer();
        const finishedSession = activeWheelZoomSession;
        if (!finishedSession) {
            return;
        }
        const viewerState = summarizeViewerStateForLog();
        BrowserLogger.warn('pdf-zoom-debug', `[wheel-zoom-session] end reason=${reason}`, {
            reason,
            session: finishedSession,
            viewer: viewerState,
            sessionDurationMs: Date.now() - finishedSession.startedAtMs,
            packetCount: finishedSession.packetCount,
            emittedCount: finishedSession.emittedCount,
            scrollDriftFromSessionStart: {
                top: (
                    viewerState?.scrollTop !== undefined
                    && finishedSession.startScrollTop !== null
                )
                    ? viewerState.scrollTop - finishedSession.startScrollTop
                    : null,
                left: (
                    viewerState?.scrollLeft !== undefined
                    && finishedSession.startScrollLeft !== null
                )
                    ? viewerState.scrollLeft - finishedSession.startScrollLeft
                    : null,
            },
        });
        activeWheelZoomSession = null;
        maybeReleaseZoomVirtualizationFreeze(`session-end:${reason}`);
    }

    function getActiveWheelZoomSession(nowMs = Date.now()) {
        if (!activeWheelZoomSession) {
            return null;
        }
        if (nowMs > activeWheelZoomSession.lockUntilMs) {
            endWheelZoomSession('lock-expired');
            return null;
        }
        return activeWheelZoomSession;
    }

    function scheduleWheelZoomSessionIdleTimeout(sessionId: number) {
        clearWheelZoomSessionIdleTimer();
        wheelZoomSessionIdleTimer = setTimeout(() => {
            if (!activeWheelZoomSession || activeWheelZoomSession.id !== sessionId) {
                return;
            }
            const idleMs = Date.now() - activeWheelZoomSession.lastPacketAtMs;
            if (idleMs < WHEEL_ZOOM_SESSION_IDLE_MS) {
                scheduleWheelZoomSessionIdleTimeout(sessionId);
                return;
            }
            endWheelZoomSession('idle-timeout');
        }, WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS);
    }

    function ensureWheelZoomSession(
        nowMs: number,
        anchorX: number,
        anchorY: number,
        eventId: number,
    ) {
        const current = activeWheelZoomSession;
        const shouldReuseCurrent = Boolean(
            current
            && nowMs - current.lastPacketAtMs <= WHEEL_ZOOM_GESTURE_GRACE_MS,
        );
        if (shouldReuseCurrent && current) {
            if (!zoomVirtualizationFreeze.value) {
                captureZoomVirtualizationFreeze(current.id, 'session-reuse');
            }
            current.lastPacketAtMs = nowMs;
            current.lockUntilMs = nowMs + WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS;
            current.lastEventId = eventId;
            scheduleWheelZoomSessionIdleTimeout(current.id);
            return {
                session: current,
                reused: true,
            };
        }

        wheelZoomSessionId += 1;
        const nextSession: IWheelZoomSession = {
            id: wheelZoomSessionId,
            anchorX,
            anchorY,
            startZoom: effectiveScale.value,
            cumulativeDelta: 0,
            lastEmittedZoom: effectiveScale.value,
            startedAtMs: nowMs,
            lastPacketAtMs: nowMs,
            lockUntilMs: nowMs + WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS,
            lastEventId: eventId,
            packetCount: 0,
            emittedCount: 0,
            startScrollTop: viewerContainer.value ? Math.round(viewerContainer.value.scrollTop) : null,
            startScrollLeft: viewerContainer.value ? Math.round(viewerContainer.value.scrollLeft) : null,
        };
        activeWheelZoomSession = nextSession;
        captureZoomVirtualizationFreeze(nextSession.id, 'session-start');
        BrowserLogger.warn('pdf-zoom-debug', '[wheel-zoom-session] start', {
            session: nextSession,
            viewer: summarizeViewerStateForLog(),
        });
        scheduleWheelZoomSessionIdleTimeout(nextSession.id);
        return {
            session: nextSession,
            reused: false,
        };
    }

    function setZoomRerenderBusy(busy: boolean) {
        isZoomRerenderBusyFromCore = busy;
        zoomRerenderBusyLockUntilMs = Date.now()
            + (busy ? WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS : WHEEL_ZOOM_GESTURE_GRACE_MS);
        if (busy) {
            markExpectedZoomScroll(WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS);
            captureZoomVirtualizationFreeze(
                activeWheelZoomSession?.id ?? null,
                'core-rerender-busy',
            );
        } else {
            maybeReleaseZoomVirtualizationFreeze('core-rerender-idle');
        }
        BrowserLogger.warn('pdf-zoom-debug', `[wheel-zoom-session] core-busy=${busy}`, {
            busy,
            lockUntilMs: zoomRerenderBusyLockUntilMs,
            activeSessionId: activeWheelZoomSession?.id ?? null,
        });
    }

    function isWheelZoomGestureLocked(nowMs = Date.now()) {
        const session = getActiveWheelZoomSession(nowMs);
        return Boolean(session && nowMs <= session.lockUntilMs);
    }

    function isZoomInteractionLocked(nowMs = Date.now()) {
        const sessionLocked = isWheelZoomGestureLocked(nowMs);
        const coreLocked = isZoomRerenderBusyFromCore || nowMs <= zoomRerenderBusyLockUntilMs;
        return sessionLocked || coreLocked;
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
            pendingImmediateZoomRestoreIntent = {
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
            coreZoomRerenderBusy: isZoomRerenderBusyFromCore,
            coreZoomRerenderLockAgeMs: zoomRerenderBusyLockUntilMs > nowMs
                ? zoomRerenderBusyLockUntilMs - nowMs
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
        const zoomScrollExpected = nowMs <= expectedZoomScrollUntilMs;
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
                    expectedZoomScrollUntilMs,
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

    function consumeZoomViewportAnchor() {
        const nowMs = Date.now();
        const pendingAnchor = pendingZoomViewportAnchor.value;
        if (!pendingAnchor) {
            const activeSession = getActiveWheelZoomSession(nowMs);
            const canUseSessionFallback = Boolean(
                activeSession
                && nowMs - activeSession.lastPacketAtMs <= WHEEL_ZOOM_GESTURE_GRACE_MS,
            );
            if (canUseSessionFallback && activeSession) {
                const fallbackAnchor: IZoomViewportAnchorIntent = {
                    id: activeSession.lastEventId,
                    sessionId: activeSession.id,
                    x: activeSession.anchorX,
                    y: activeSession.anchorY,
                    capturedAtMs: activeSession.lastPacketAtMs,
                };
                BrowserLogger.warnThrottled(
                    'pdf-zoom-debug',
                    'anchor-consume-session-fallback',
                    WHEEL_DETAIL_LOG_THROTTLE_MS,
                    `[anchor-consume] session-fallback id=${fallbackAnchor.id}`,
                    {
                        id: fallbackAnchor.id,
                        sessionId: fallbackAnchor.sessionId,
                        anchor: fallbackAnchor,
                        viewer: summarizeViewerStateForLog(),
                    },
                );
                return fallbackAnchor;
            }
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'anchor-consume-none',
                WHEEL_DETAIL_LOG_THROTTLE_MS,
                '[anchor-consume] none',
            );
            return null;
        }
        const ageMs = nowMs - pendingAnchor.capturedAtMs;
        const zoomLockActive = isZoomInteractionLocked(nowMs);
        const activeSession = getActiveWheelZoomSession(nowMs);
        const belongsToActiveSession = activeSession?.id === pendingAnchor.sessionId;
        const staleWithoutZoomContext =
            ageMs > ZOOM_VIEWPORT_ANCHOR_MAX_AGE_MS
            && !zoomLockActive
            && !belongsToActiveSession;
        if (staleWithoutZoomContext) {
            pendingZoomViewportAnchor.value = null;
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'anchor-consume-stale',
                WHEEL_DETAIL_LOG_THROTTLE_MS,
                `[anchor-consume] stale id=${pendingAnchor.id}`,
                {
                    id: pendingAnchor.id,
                    sessionId: pendingAnchor.sessionId,
                    ageMs,
                    anchor: pendingAnchor,
                    viewer: summarizeViewerStateForLog(),
                },
            );
            return null;
        }
        pendingZoomViewportAnchor.value = null;
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'anchor-consume',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            `[anchor-consume] id=${pendingAnchor.id}`,
            {
                id: pendingAnchor.id,
                sessionId: pendingAnchor.sessionId,
                ageMs,
                zoomLockActive,
                anchor: pendingAnchor,
                viewer: summarizeViewerStateForLog(),
            },
        );
        return pendingAnchor;
    }

    watch(
        () => zoom.value,
        (nextZoom, previousZoom) => {
            const pendingIntent = pendingImmediateZoomRestoreIntent;
            if (!pendingIntent) {
                return;
            }
            const container = viewerContainer.value;
            if (!container) {
                pendingImmediateZoomRestoreIntent = null;
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
            pendingImmediateZoomRestoreIntent = null;
        },
        { flush: 'post' },
    );

    onScopeDispose(() => {
        clearWheelZoomSessionIdleTimer();
        clearZoomSnapSuppressedTimer();
        activeWheelZoomSession = null;
        isZoomRerenderBusyFromCore = false;
        zoomRerenderBusyLockUntilMs = 0;
        expectedZoomScrollUntilMs = 0;
        zoomSnapSuppressed.value = false;
        zoomVirtualizationFreeze.value = null;
        pendingImmediateZoomRestoreIntent = null;
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
