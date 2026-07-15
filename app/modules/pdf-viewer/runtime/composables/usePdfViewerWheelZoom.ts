import type {
    ComputedRef,
    Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
import { ZOOM } from '@app/constants/pdfLayout';
import { clampPdfManualZoom } from '@app/modules/pdf-viewer/runtime/zoom/resolvePdfZoomScale';
import type { TZoomMode } from '@app/types/pdfContracts';
import type { TPdfSource } from '@app/types/pdfUi';
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
const MAC_PLATFORM_PATTERN = /Mac|iPhone|iPad|iPod/i;

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
    zoomVirtualizationFreeze: Ref<IZoomVirtualizationFreeze | null>;
    singlePageScroll: {
        suppressSnapFor: (ms: number) => void;
        handleWheel: (event: WheelEvent) => boolean;
        handleScroll: (event?: Event, authorityScrollConsumed?: boolean) => void;
        consumeAuthorityScroll?: () => boolean;
        cancelProgrammaticNavigation: (reason?: string) => void;
        isProgrammaticNavigationActive?: Ref<boolean>;
        shouldCancelProgrammaticNavigationForViewportScroll?: () => boolean;
    };
    cancelPendingSearchScroll: () => void;
    markUserViewportInteraction?: (() => void) | undefined;
    submitZoomIntent: (intent: {
        zoom: number;
        x: number;
        y: number
    }) => void;
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
        zoomVirtualizationFreeze,
        singlePageScroll,
        cancelPendingSearchScroll,
        markUserViewportInteraction,
        submitZoomIntent,
        isSnipActive,
        emit,
    } = options;

    let zoomDebugWheelEventId = 0;
    let lastViewerScrollTop = 0;
    let lastViewerScrollLeft = 0;
    let lastModifierWheelZoomAtMs = 0;
    let lastModifierWheelZoomEventId = 0;

    function isMacLikePlatform() {
        if (typeof navigator === 'undefined') {
            return false;
        }
        const userAgentNavigator = navigator as Navigator & {userAgentData?: {platform?: string;};};
        const platform = userAgentNavigator.userAgentData?.platform
            ?? userAgentNavigator.platform
            ?? '';
        return MAC_PLATFORM_PATTERN.test(platform);
    }

    function isMacControlWheel(event: WheelEvent) {
        return isMacLikePlatform()
            && event.ctrlKey
            && !event.metaKey;
    }

    function summarizeViewerStateForLog() {
        return summarizeViewerMetrics(viewerContainer.value);
    }
    const {
        pendingZoomViewportAnchor,
        zoomSnapSuppressed,
        getActiveWheelZoomSession,
        ensureWheelZoomSession,
        markExpectedZoomScroll,
        completeExpectedZoomScroll,
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
        return clampPdfManualZoom(level);
    }

    function resolveCumulativeDeltaForEffectiveZoom(startZoom: number, targetZoom: number) {
        if (
            !Number.isFinite(startZoom)
            || startZoom <= 0
            || !Number.isFinite(targetZoom)
            || targetZoom <= 0
        ) {
            return null;
        }

        return -Math.log(targetZoom / startZoom) / WHEEL_ZOOM_SENSITIVITY;
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
        const hasModifierZoomSignal = (event.ctrlKey && !isMacControlWheel(event))
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
        let zoomFactor = Math.exp(-session.cumulativeDelta * WHEEL_ZOOM_SENSITIVITY);
        if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
            return {
                valid: false as const,
                zoomFactor,
            };
        }

        const rawNextEffectiveZoom = session.startZoom * zoomFactor;
        if (session.startZoom < ZOOM.MIN && rawNextEffectiveZoom <= session.startZoom) {
            session.cumulativeDelta = 0;
            session.lastEmittedZoom = session.startZoom;
            return {
                valid: false as const,
                zoomFactor: 1,
                reason: 'below-manual-min-zoom-out' as const,
            };
        }
        const nextEffectiveZoom = clampZoomLevel(rawNextEffectiveZoom);
        if (Math.abs(rawNextEffectiveZoom - nextEffectiveZoom) >= 0.001) {
            const clampedCumulativeDelta = resolveCumulativeDeltaForEffectiveZoom(
                session.startZoom,
                nextEffectiveZoom,
            );
            if (clampedCumulativeDelta !== null) {
                session.cumulativeDelta = clampedCumulativeDelta;
                zoomFactor = nextEffectiveZoom / session.startZoom;
            }
        }

        return {
            valid: true as const,
            nextEffectiveZoom,
            nextZoom: nextEffectiveZoom,
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
        debugId: number,
        sessionId: number,
        zoomLockOperationId: number | null,
        anchorX: number,
        anchorY: number,
        nowMs: number,
    ) {
        pendingZoomViewportAnchor.value = {
            id: debugId,
            sessionId,
            zoomLockOperationId,
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
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'wheel-dispatch', WHEEL_DISPATCH_LOG_THROTTLE_MS, '[wheel] dispatch', {
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
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'wheel-blocked-snip', wheelDetailLogThrottleMs, '[wheel] blocked by snip mode');
        return true;
    }

    function routePhysicalMacControlWheelToScroll(event: WheelEvent) {
        if (!isMacControlWheel(event)) {
            return false;
        }

        cleanupWheelZoomSession();
        BrowserLogger.diagnosticThrottled(
            'pdf-zoom-debug',
            'wheel-routed-physical-mac-control-to-scroll',
            wheelDetailLogThrottleMs,
            '[wheel] allowed physical macOS Control wheel to scroll',
            {
                viewer: summarizeViewerStateForLog(),
                wheel: summarizeWheelEventForDebug(event),
            },
        );
        cancelPendingSearchScroll();
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

    function hasWheelZoomSuppressionContext(context: IWheelDispatchContext) {
        const withinExpectedModifierWindow = context.modifierZoomAgeMs !== null
            && context.modifierZoomAgeMs <= wheelZoomExpectedScrollWindowMs;
        const hasRecentZoomAnchor = context.recentZoomAgeMs !== null
            && context.recentZoomAgeMs <= wheelZoomExpectedScrollWindowMs;

        return (
            context.activeSession !== null
            || context.isWithinModifierZoomGraceWindow
            || withinExpectedModifierWindow
            || hasRecentZoomAnchor
        );
    }

    function suppressWheelDuringActiveZoom(event: WheelEvent, context: IWheelDispatchContext) {
        if (!hasWheelZoomSuppressionContext(context)) {
            return false;
        }

        if (!context.zoomInteractionLocked && !context.isWithinModifierZoomGraceWindow) {
            return false;
        }

        event.preventDefault();
        suppressSinglePageSnapForWheelZoom();
        BrowserLogger.diagnosticThrottled(
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
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'scroll-viewer', WHEEL_SCROLL_LOG_THROTTLE_MS, '[scroll] viewer', {
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

        BrowserLogger.diagnosticThrottled(
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
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'wheel-zoom-received', wheelDetailLogThrottleMs, `[wheel-zoom] received id=${debugId}`, {
            id: debugId,
            hasModifierZoomSignal: wheelIntent.hasModifierZoomSignal,
            shouldTreatAsZoomSignal: wheelIntent.shouldTreatAsZoomSignal,
            isContinuationPacket: wheelIntent.isContinuationPacket,
            activeSessionId: wheelIntent.activeSession?.id ?? null,
            viewer: summarizeViewerStateForLog(),
            wheel: summarizeWheelEventForDebug(event),
        });
        if (!wheelIntent.shouldTreatAsZoomSignal) {
            BrowserLogger.diagnosticThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-no-modifier',
                wheelDetailLogThrottleMs,
                `[wheel-zoom] ignored id=${debugId} reason=no-zoom-signal`,
            );
            return false;
        }

        lastModifierWheelZoomAtMs = nowMs;
        lastModifierWheelZoomEventId = debugId;
        const zoomLockOperationId = markExpectedZoomScroll(wheelZoomExpectedScrollWindowMs);

        event.preventDefault();
        BrowserLogger.diagnosticThrottled(
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
            BrowserLogger.diagnosticThrottled(
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
        } = ensureWheelZoomSession(nowMs, eventAnchor.x, eventAnchor.y, debugId, zoomLockOperationId);
        session.packetCount += 1;
        const anchorX = session.anchorX;
        const anchorY = session.anchorY;

        const delta = resolveWheelZoomDelta(event, container);
        if (Math.abs(delta) < Number.EPSILON) {
            BrowserLogger.diagnosticThrottled(
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
            BrowserLogger.diagnosticThrottled(
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
            BrowserLogger.diagnosticThrottled(
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
        setPendingZoomAnchors(debugId, session.id, zoomLockOperationId, anchorX, anchorY, nowMs);
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'wheel-zoom-emit', wheelDetailLogThrottleMs, `[wheel-zoom] emit id=${debugId}`, {
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
        submitZoomIntent({
            zoom: zoomTarget.nextZoom,
            x: anchorX,
            y: anchorY,
        });
        markExpectedZoomScroll(wheelZoomExpectedScrollWindowMs, {
            operationId: zoomLockOperationId,
            reason: 'wheel-zoom-emitted',
        });
        return true;
    }

    function handleViewerWheel(event: WheelEvent) {
        const context = createWheelDispatchContext();
        logWheelDispatch(event, context);

        if (blockWheelForSnipMode(event)) {
            return;
        }

        function markWheelViewportInteraction() {
            if (markUserViewportInteraction) {
                markUserViewportInteraction();
                return;
            }
            singlePageScroll.cancelProgrammaticNavigation('wheel-interaction');
        }

        if (
            routePhysicalMacControlWheelToScroll(event)
            || routeModifierWheelZoom(event)
            || suppressWheelDuringActiveZoom(event, context)
        ) {
            markWheelViewportInteraction();
            return;
        }

        cancelPendingSearchScroll();
        if (singlePageScroll.handleWheel(event)) {
            return;
        }

        markWheelViewportInteraction();
    }

    function handleViewerScroll(event: Event) {
        if (singlePageScroll.consumeAuthorityScroll?.()) {
            singlePageScroll.handleScroll(undefined, true);
            return;
        }
        const context = createViewerScrollContext();
        logViewerScroll(event, context);
        warnUnexpectedScrollDriftIfNeeded(context);

        if (context.zoomInteractionLocked || context.zoomScrollExpected) {
            suppressSinglePageSnapForWheelZoom();
        }

        if (context.zoomScrollExpected) {
            completeExpectedZoomScroll({
                operationId: context.activeZoomIntent?.zoomLockOperationId,
                reason: 'viewer-scroll-applied',
            });
        }

        const shouldCancelProgrammaticNavigation = singlePageScroll.shouldCancelProgrammaticNavigationForViewportScroll
            ? singlePageScroll.shouldCancelProgrammaticNavigationForViewportScroll()
            : singlePageScroll.isProgrammaticNavigationActive?.value !== true;
        if (
            !context.zoomInteractionLocked
            && !context.zoomScrollExpected
            && shouldCancelProgrammaticNavigation
        ) {
            if (markUserViewportInteraction) {
                markUserViewportInteraction();
            } else {
                singlePageScroll.cancelProgrammaticNavigation('viewer-scroll-interaction');
            }
        }

        singlePageScroll.handleScroll(event);
    }

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
