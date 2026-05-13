import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IScrollSnapshot } from '@app/types/pdf';
import {
    WHEEL_DETAIL_LOG_THROTTLE_MS,
    WHEEL_ZOOM_GESTURE_GRACE_MS,
    WHEEL_ZOOM_SESSION_IDLE_MS,
    WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS,
    ZOOM_VIEWPORT_ANCHOR_MAX_AGE_MS,
} from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerWheelZoom.constants';
import { usePdfViewerZoomInteractionLock } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerZoomInteractionLock';
import type { IZoomVirtualizationLogOptions } from '@app/modules/pdf-viewer-runtime/composables/pdfViewerZoomTypes';

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

interface IUsePdfViewerWheelZoomSessionOptions extends IZoomVirtualizationLogOptions {
    viewerContainer: Ref<HTMLElement | null>;
    effectiveScale: Ref<number>;
}

export const usePdfViewerWheelZoomSession = (options: IUsePdfViewerWheelZoomSessionOptions) => {
    const {
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
    } = options;

    const pendingZoomViewportAnchor = ref<IZoomViewportAnchorIntent | null>(null);
    const pendingImmediateZoomRestoreIntent = ref<IImmediateZoomRestoreIntent | null>(null);

    let wheelZoomSessionId = 0;
    let activeWheelZoomSession: IWheelZoomSession | null = null;
    let wheelZoomSessionIdleTimer: ReturnType<typeof setTimeout> | null = null;

    function clearWheelZoomSessionIdleTimer() {
        if (wheelZoomSessionIdleTimer !== null) {
            clearTimeout(wheelZoomSessionIdleTimer);
            wheelZoomSessionIdleTimer = null;
        }
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

    function isWheelZoomGestureLocked(nowMs = Date.now()) {
        const session = getActiveWheelZoomSession(nowMs);
        return Boolean(session && nowMs <= session.lockUntilMs);
    }

    const {
        zoomSnapSuppressed,
        captureZoomVirtualizationFreeze,
        maybeReleaseZoomVirtualizationFreeze,
        markExpectedZoomScroll,
        setZoomRerenderBusy,
        isZoomInteractionLocked,
        cleanupZoomInteractionLock,
        getIsZoomRerenderBusyFromCore,
        getZoomRerenderBusyLockUntilMs,
        getExpectedZoomScrollUntilMs,
    } = usePdfViewerZoomInteractionLock({
        currentPage,
        visibleRange,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        zoomVirtualizationFreeze,
        summarizeViewerStateForLog,
        getActiveSessionId: () => activeWheelZoomSession?.id ?? null,
        isWheelZoomGestureLocked,
    });

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
                top: viewerState && finishedSession.startScrollTop !== null
                    ? viewerState.scrollTop - finishedSession.startScrollTop
                    : null,
                left: viewerState && finishedSession.startScrollLeft !== null
                    ? viewerState.scrollLeft - finishedSession.startScrollLeft
                    : null,
            },
        });
        activeWheelZoomSession = null;
        maybeReleaseZoomVirtualizationFreeze(`session-end:${reason}`);
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

    function cleanupWheelZoomSession() {
        clearWheelZoomSessionIdleTimer();
        activeWheelZoomSession = null;
        cleanupZoomInteractionLock();
        pendingImmediateZoomRestoreIntent.value = null;
    }

    return {
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
    };
};
