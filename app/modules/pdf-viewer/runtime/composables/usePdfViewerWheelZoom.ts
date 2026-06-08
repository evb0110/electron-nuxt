import type {
    ComputedRef,
    Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import { captureScrollSnapshot } from '@app/utils/pdf-viewer/pdf-page-render-pipeline/captureScrollSnapshot';
import { restoreScrollFromSnapshot } from '@app/utils/pdf-viewer/pdf-page-render-pipeline/restoreScrollFromSnapshot';
import { summarizeViewerMetrics } from '@app/utils/pdf-viewer/pdf-viewer-metrics/summarizeViewerMetrics';
import { ZOOM } from '@app/constants/pdfLayout';
import type {
    TPdfSource,
    TZoomMode,
} from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IZoomVirtualizationFreeze } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';
import { wheelDetailLogThrottleMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelDetailLogThrottleMs';
import { wheelZoomExpectedScrollWindowMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomExpectedScrollWindowMs';
import { wheelZoomGestureGraceMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomGestureGraceMs';
import { wheelZoomSessionIdleMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomSessionIdleMs';
import { wheelZoomSessionLockExtensionMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomSessionLockExtensionMs';
import { usePdfViewerWheelZoomSession } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerWheelZoomSession';

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
        cancelContinuousNavigationTarget: () => void;
    };
    cancelPendingSearchScroll: () => void;
    markUserViewportInteraction?: (() => void) | undefined;
    isSnipActive: () => boolean;
    emit: IWheelEmit;
}

type TWheelZoomSessionApi = ReturnType<typeof usePdfViewerWheelZoomSession>;
type TWheelZoomAnchor = TWheelZoomSessionApi['pendingZoomViewportAnchor']['value'];
type TWheelZoomActiveSession = ReturnType<TWheelZoomSessionApi['getActiveWheelZoomSession']>;

interface IWheelDispatchContext {
    nowMs: number;
    recentZoomAnchor: TWheelZoomAnchor;
    recentZoomAgeMs: number | null;
    modifierZoomAgeMs: number | null;
    isWithinModifierZoomGraceWindow: boolean;
    activeSession: TWheelZoomActiveSession;
    zoomInteractionLocked: boolean;
}

interface IViewerScrollContext {
    nowMs: number;
    deltaTop: number | null;
    deltaLeft: number | null;
    activeZoomIntent: TWheelZoomAnchor;
    activeSession: TWheelZoomActiveSession;
    zoomInteractionLocked: boolean;
    zoomScrollExpected: boolean;
}

export const usePdfViewerWheelZoom = (options: IUsePdfViewerWheelZoomOptions) => {
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
        markUserViewportInteraction,
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

    function getModifierWheelIntent(event: WheelEvent, nowMs: number) {
        const activeSession = getActiveWheelZoomSession(nowMs);
        const isContinuationPacket = Boolean(
            activeSession
            && nowMs - activeSession.lastPacketAtMs <= wheelZoomGestureGraceMs,
        );
        const hasModifierZoomSignal = event.ctrlKey
            || event.metaKey
            || Math.abs(event.deltaZ) > Number.EPSILON;

        return {
            activeSession,
            hasModifierZoomSignal,
            isContinuationPacket,
            shouldTreatAsZoomSignal: hasModifierZoomSignal || isContinuationPacket,
        };
    }

    function getWheelZoomEventAnchor(event: WheelEvent, container: HTMLElement) {
        const containerRect = container.getBoundingClientRect();

        return {
            x: clamp(
                event.clientX - containerRect.left,
                0,
                Math.max(container.clientWidth, 0),
            ),
            y: clamp(
                event.clientY - containerRect.top,
                0,
                Math.max(container.clientHeight, 0),
            ),
        };
    }

    function normalizeFallbackWheelZoomDelta(event: WheelEvent, container: HTMLElement) {
        if (event.deltaMode === 1) {
            return event.deltaZ * WHEEL_LINE_DELTA_PX;
        }
        if (event.deltaMode === 2) {
            return event.deltaZ * Math.max(container.clientHeight, 1);
        }
        return event.deltaZ;
    }

    function resolveWheelZoomDelta(event: WheelEvent, container: HTMLElement) {
        const delta = normalizeWheelZoomDelta(event, container);
        if (Math.abs(delta) >= Number.EPSILON || Math.abs(event.deltaZ) <= Number.EPSILON) {
            return delta;
        }

        return normalizeFallbackWheelZoomDelta(event, container);
    }

    function resolveWheelZoomTarget(
        delta: number,
        session: ReturnType<typeof ensureWheelZoomSession>['session'],
    ) {
        session.cumulativeDelta += delta;
        const zoomFactor = Math.exp(-session.cumulativeDelta * WHEEL_ZOOM_SENSITIVITY);
        if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
            return {
                valid: false as const,
                zoomFactor,
            };
        }

        const nextEffectiveZoom = clampZoomLevel(session.startZoom * zoomFactor);
        const baselineScale = resolveZoomBaselineScale();

        return {
            valid: true as const,
            baselineScale,
            nextEffectiveZoom,
            nextZoom: clampZoomLevel(nextEffectiveZoom / baselineScale),
            zoomFactor,
        };
    }

    function updateWheelZoomSessionAfterEmit(
        session: ReturnType<typeof ensureWheelZoomSession>['session'],
        nextEffectiveZoom: number,
        nowMs: number,
    ) {
        session.lastEmittedZoom = nextEffectiveZoom;
        session.lastPacketAtMs = nowMs;
        session.lockUntilMs = nowMs + wheelZoomSessionIdleMs + wheelZoomSessionLockExtensionMs;
        session.emittedCount += 1;
    }

    function setPendingZoomAnchors(
        container: HTMLElement,
        debugId: number,
        sessionId: number,
        anchorX: number,
        anchorY: number,
        nowMs: number,
    ) {
        const snapshotForImmediateRestore = captureScrollSnapshot(container, {
            anchorViewportX: anchorX,
            anchorViewportY: anchorY,
        });
        if (snapshotForImmediateRestore) {
            pendingImmediateZoomRestoreIntent.value = {
                id: debugId,
                sessionId,
                snapshot: snapshotForImmediateRestore,
                capturedAtMs: nowMs,
            };
        }

        pendingZoomViewportAnchor.value = {
            id: debugId,
            sessionId,
            x: anchorX,
            y: anchorY,
            capturedAtMs: nowMs,
        };
    }

    function suppressSinglePageSnapForWheelZoom() {
        singlePageScroll.suppressSnapFor(
            Math.max(
                wheelZoomSessionIdleMs + wheelZoomSessionLockExtensionMs,
                wheelZoomExpectedScrollWindowMs,
            ),
        );
    }

    function readViewerScrollPosition() {
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

        return {
            deltaTop,
            deltaLeft,
        };
    }

    function hasUnexpectedScrollDrift(deltaTop: number | null, deltaLeft: number | null) {
        return (typeof deltaTop === 'number' && Math.abs(deltaTop) >= 10)
            || (typeof deltaLeft === 'number' && Math.abs(deltaLeft) >= 10);
    }

    function createWheelDispatchContext(): IWheelDispatchContext {
        const nowMs = Date.now();
        const recentZoomAnchor = pendingZoomViewportAnchor.value;
        const recentZoomAgeMs = recentZoomAnchor
            ? nowMs - recentZoomAnchor.capturedAtMs
            : null;
        const modifierZoomAgeMs = lastModifierWheelZoomAtMs > 0
            ? nowMs - lastModifierWheelZoomAtMs
            : null;
        const isWithinModifierZoomGraceWindow = modifierZoomAgeMs !== null
            && modifierZoomAgeMs <= wheelZoomGestureGraceMs;

        return {
            nowMs,
            recentZoomAnchor,
            recentZoomAgeMs,
            modifierZoomAgeMs,
            isWithinModifierZoomGraceWindow,
            activeSession: getActiveWheelZoomSession(nowMs),
            zoomInteractionLocked: isZoomInteractionLocked(nowMs),
        };
    }

    function logWheelDispatch(event: WheelEvent, context: IWheelDispatchContext) {
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-dispatch', WHEEL_DISPATCH_LOG_THROTTLE_MS, '[wheel] dispatch', {
            recentZoomIntentId: context.recentZoomAnchor?.id ?? null,
            recentZoomAgeMs: context.recentZoomAgeMs,
            recentModifierZoomEventId: lastModifierWheelZoomEventId || null,
            modifierZoomAgeMs: context.modifierZoomAgeMs,
            withinModifierZoomGraceWindow: context.isWithinModifierZoomGraceWindow,
            activeSessionId: context.activeSession?.id ?? null,
            zoomInteractionLocked: context.zoomInteractionLocked,
            coreZoomRerenderBusy: getIsZoomRerenderBusyFromCore(),
            coreZoomRerenderLockAgeMs: getZoomRerenderBusyLockUntilMs() > context.nowMs
                ? getZoomRerenderBusyLockUntilMs() - context.nowMs
                : 0,
            viewer: summarizeViewerStateForLog(),
            wheel: summarizeWheelEventForDebug(event),
        });
    }

    function blockWheelForSnipMode(event: WheelEvent) {
        if (!isSnipActive()) {
            return false;
        }

        event.preventDefault();
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-blocked-snip', wheelDetailLogThrottleMs, '[wheel] blocked by snip mode');
        return true;
    }

    function routeModifierWheelZoom(event: WheelEvent) {
        if (!handleViewerModifierWheelZoom(event)) {
            return false;
        }

        suppressSinglePageSnapForWheelZoom();
        cancelPendingSearchScroll();
        return true;
    }

    function suppressWheelDuringActiveZoom(event: WheelEvent, context: IWheelDispatchContext) {
        if (!context.zoomInteractionLocked && !context.isWithinModifierZoomGraceWindow) {
            return false;
        }

        event.preventDefault();
        suppressSinglePageSnapForWheelZoom();
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'wheel-suppressed-non-modifier',
            wheelDetailLogThrottleMs,
            '[wheel] suppressed non-modifier packet during active zoom lock',
            {
                zoomInteractionLocked: context.zoomInteractionLocked,
                graceWindowMs: wheelZoomGestureGraceMs,
                recentModifierZoomEventId: lastModifierWheelZoomEventId || null,
                modifierZoomAgeMs: context.modifierZoomAgeMs,
                activeSessionId: context.activeSession?.id ?? null,
                viewer: summarizeViewerStateForLog(),
                wheel: summarizeWheelEventForDebug(event),
            },
        );
        cancelPendingSearchScroll();
        return true;
    }

    function createViewerScrollContext(): IViewerScrollContext {
        const nowMs = Date.now();
        const {
            deltaTop,
            deltaLeft,
        } = readViewerScrollPosition();
        const activeZoomIntent = pendingZoomViewportAnchor.value;

        return {
            nowMs,
            deltaTop,
            deltaLeft,
            activeZoomIntent,
            activeSession: getActiveWheelZoomSession(nowMs),
            zoomInteractionLocked: isZoomInteractionLocked(nowMs),
            zoomScrollExpected: nowMs <= getExpectedZoomScrollUntilMs(),
        };
    }

    function logViewerScroll(event: Event, context: IViewerScrollContext) {
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'scroll-viewer', WHEEL_SCROLL_LOG_THROTTLE_MS, '[scroll] viewer', {
            type: event.type,
            deltaTop: context.deltaTop,
            deltaLeft: context.deltaLeft,
            viewer: summarizeViewerStateForLog(),
            activeZoomIntentId: context.activeZoomIntent?.id ?? null,
            activeZoomIntentAgeMs: context.activeZoomIntent
                ? context.nowMs - context.activeZoomIntent.capturedAtMs
                : null,
            activeSessionId: context.activeSession?.id ?? null,
            zoomInteractionLocked: context.zoomInteractionLocked,
            zoomScrollExpected: context.zoomScrollExpected,
        });
    }

    function warnUnexpectedScrollDriftIfNeeded(context: IViewerScrollContext) {
        if (
            !context.zoomInteractionLocked
            || context.zoomScrollExpected
            || !hasUnexpectedScrollDrift(context.deltaTop, context.deltaLeft)
        ) {
            return;
        }

        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'scroll-drift-unexpected-during-zoom-lock',
            WHEEL_SCROLL_LOG_THROTTLE_MS,
            '[scroll-drift] unexpected scroll delta during active zoom lock',
            {
                deltaTop: context.deltaTop,
                deltaLeft: context.deltaLeft,
                activeSessionId: context.activeSession?.id ?? null,
                recentZoomIntentId: context.activeZoomIntent?.id ?? null,
                recentZoomIntentAgeMs: context.activeZoomIntent
                    ? context.nowMs - context.activeZoomIntent.capturedAtMs
                    : null,
                expectedZoomScrollUntilMs: getExpectedZoomScrollUntilMs(),
                viewer: summarizeViewerStateForLog(),
            },
        );
    }

    function handleViewerModifierWheelZoom(event: WheelEvent) {
        const nowMs = Date.now();
        const debugId = ++zoomDebugWheelEventId;
        const wheelIntent = getModifierWheelIntent(event, nowMs);
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-zoom-received', wheelDetailLogThrottleMs, `[wheel-zoom] received id=${debugId}`, {
            id: debugId,
            hasModifierZoomSignal: wheelIntent.hasModifierZoomSignal,
            shouldTreatAsZoomSignal: wheelIntent.shouldTreatAsZoomSignal,
            isContinuationPacket: wheelIntent.isContinuationPacket,
            activeSessionId: wheelIntent.activeSession?.id ?? null,
            viewer: summarizeViewerStateForLog(),
            wheel: summarizeWheelEventForDebug(event),
        });
        if (!wheelIntent.shouldTreatAsZoomSignal) {
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-no-modifier',
                wheelDetailLogThrottleMs,
                `[wheel-zoom] ignored id=${debugId} reason=no-zoom-signal`,
            );
            return false;
        }

        lastModifierWheelZoomAtMs = nowMs;
        lastModifierWheelZoomEventId = debugId;
        markExpectedZoomScroll(wheelZoomExpectedScrollWindowMs);

        event.preventDefault();
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'wheel-zoom-prevent-default',
            wheelDetailLogThrottleMs,
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
                wheelDetailLogThrottleMs,
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

        const eventAnchor = getWheelZoomEventAnchor(event, container);
        const {
            session,
            reused: reusedGestureAnchor,
        } = ensureWheelZoomSession(nowMs, eventAnchor.x, eventAnchor.y, debugId);
        session.packetCount += 1;
        const anchorX = session.anchorX;
        const anchorY = session.anchorY;

        const delta = resolveWheelZoomDelta(event, container);
        if (Math.abs(delta) < Number.EPSILON) {
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-zero-delta',
                wheelDetailLogThrottleMs,
                `[wheel-zoom] ignored id=${debugId} reason=zero-delta`,
                {
                    id: debugId,
                    wheel: summarizeWheelEventForDebug(event),
                },
            );
            return true;
        }

        const zoomTarget = resolveWheelZoomTarget(delta, session);
        if (!zoomTarget.valid) {
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-invalid-factor',
                wheelDetailLogThrottleMs,
                `[wheel-zoom] ignored id=${debugId} reason=invalid-factor`,
                {
                    id: debugId,
                    deltaCumulative: session.cumulativeDelta,
                    zoomFactor: zoomTarget.zoomFactor,
                    sessionId: session.id,
                },
            );
            return true;
        }

        const previousEmittedZoom = session.lastEmittedZoom;
        if (Math.abs(zoomTarget.nextEffectiveZoom - previousEmittedZoom) < 0.001) {
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-no-change',
                wheelDetailLogThrottleMs,
                `[wheel-zoom] ignored id=${debugId} reason=no-zoom-change`,
                {
                    id: debugId,
                    sessionId: session.id,
                    currentZoomMultiplier: zoom.value,
                    currentEffectiveZoom: effectiveScale.value,
                    previousEmittedZoom,
                    nextEffectiveZoom: zoomTarget.nextEffectiveZoom,
                    delta,
                    zoomFactor: zoomTarget.zoomFactor,
                    cumulativeDelta: session.cumulativeDelta,
                },
            );
            return true;
        }
        updateWheelZoomSessionAfterEmit(session, zoomTarget.nextEffectiveZoom, nowMs);
        setPendingZoomAnchors(container, debugId, session.id, anchorX, anchorY, nowMs);
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-zoom-emit', wheelDetailLogThrottleMs, `[wheel-zoom] emit id=${debugId}`, {
            id: debugId,
            sessionId: session.id,
            gestureAnchorReused: reusedGestureAnchor,
            sessionStartZoom: session.startZoom,
            sessionCumulativeDelta: session.cumulativeDelta,
            eventAnchorX: eventAnchor.x,
            eventAnchorY: eventAnchor.y,
            delta,
            zoomFactor: zoomTarget.zoomFactor,
            currentZoomMultiplier: zoom.value,
            currentEffectiveZoom: effectiveScale.value,
            baselineScale: zoomTarget.baselineScale,
            previousEmittedZoom,
            nextEffectiveZoom: zoomTarget.nextEffectiveZoom,
            nextZoom: zoomTarget.nextZoom,
            anchor: pendingZoomViewportAnchor.value,
            viewerBeforeEmit: summarizeViewerStateForLog(),
            wheel: summarizeWheelEventForDebug(event),
        });

        if (zoomMode.value !== 'custom') {
            emit('update:zoomMode', 'custom');
        }
        emit('update:effectiveZoom', zoomTarget.nextEffectiveZoom);
        emit('update:zoom', zoomTarget.nextZoom);
        markExpectedZoomScroll(wheelZoomExpectedScrollWindowMs);
        return true;
    }

    function handleViewerWheel(event: WheelEvent) {
        const context = createWheelDispatchContext();
        logWheelDispatch(event, context);

        if (blockWheelForSnipMode(event)) {
            return;
        }

        markUserViewportInteraction?.();

        if (
            routeModifierWheelZoom(event)
            || suppressWheelDuringActiveZoom(event, context)
        ) {
            return;
        }

        cancelPendingSearchScroll();
        singlePageScroll.cancelContinuousNavigationTarget();
        singlePageScroll.handleWheel(event);
    }

    function handleViewerScroll(event: Event) {
        const context = createViewerScrollContext();
        logViewerScroll(event, context);
        warnUnexpectedScrollDriftIfNeeded(context);

        if (context.zoomInteractionLocked || context.zoomScrollExpected) {
            suppressSinglePageSnapForWheelZoom();
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
            BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-zoom-immediate-restore', wheelDetailLogThrottleMs, `[wheel-zoom] immediate-restore id=${pendingIntent.id}`, {
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
};
