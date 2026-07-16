import type {
    ComputedRef,
    Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
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
import {
    resolveDocumentWheelZoomTarget,
    type IDocumentWheelInteraction,
    type IDocumentWheelSourceEvent,
} from '@app/utils/document-viewer/input/documentWheelInteraction';

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
    zoomVirtualizationFreeze: Ref<IZoomVirtualizationFreeze | null>;
    singlePageScroll: {
        suppressSnapFor: (ms: number) => void;
        handleWheel: (event: IDocumentWheelSourceEvent) => boolean;
        handleScroll: (event?: Event, authorityScrollConsumed?: boolean) => void;
        consumeAuthorityScroll?: () => boolean;
        cancelProgrammaticNavigation: (reason?: string) => void;
        isProgrammaticNavigationActive?: Ref<boolean>;
        shouldCancelProgrammaticNavigationForViewportScroll?: () => boolean;
    };
    cancelPendingSearchScroll: () => void;
    markUserViewportInteraction?: (() => void) | undefined;
    captureZoomVisualSnapshots?: (() => void) | undefined;
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
        captureZoomVisualSnapshots,
        submitZoomIntent,
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

    function summarizeWheelEventForDebug(event: IDocumentWheelSourceEvent) {
        return {
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            cancelable: event.cancelable,
            defaultPrevented: event.defaultPrevented,
        };
    }

    function getModifierWheelIntent(interaction: IDocumentWheelInteraction, nowMs: number) {
        const activeSession = getActiveWheelZoomSession(nowMs);
        const isContinuationPacket = Boolean(
            activeSession
            && nowMs - activeSession.lastPacketAtMs <= wheelZoomGestureGraceMs,
        );
        const hasModifierZoomSignal = interaction.intent === 'zoom';

        return {
            activeSession,
            hasModifierZoomSignal,
            isContinuationPacket,
            shouldTreatAsZoomSignal: hasModifierZoomSignal || isContinuationPacket,
        };
    }

    function getWheelZoomEventAnchor(event: IDocumentWheelSourceEvent, container: HTMLElement) {
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

    function resolveWheelZoomTarget(
        delta: number,
        session: ReturnType<typeof ensureWheelZoomSession>['session'],
    ) {
        const target = resolveDocumentWheelZoomTarget(
            session.startZoom,
            session.cumulativeDelta,
            delta,
        );
        session.cumulativeDelta = target.cumulativeDelta;
        if (!target.valid && target.reason === 'below-manual-min-zoom-out') {
            session.lastEmittedZoom = session.startZoom;
        }
        return target;
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

    function logWheelDispatch(event: IDocumentWheelSourceEvent, context: IWheelDispatchContext) {
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

    function blockWheelForSnipMode(event: IDocumentWheelSourceEvent) {
        if (!isSnipActive()) {
            return false;
        }

        event.preventDefault();
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'wheel-blocked-snip', wheelDetailLogThrottleMs, '[wheel] blocked by snip mode');
        return true;
    }

    function routePlatformModifiedWheelToScroll(interaction: IDocumentWheelInteraction) {
        if (interaction.intent !== 'platform-scroll') {
            return false;
        }

        cleanupWheelZoomSession();
        BrowserLogger.diagnosticThrottled(
            'pdf-zoom-debug',
            'wheel-routed-platform-modifier-to-scroll',
            wheelDetailLogThrottleMs,
            '[wheel] allowed platform-modified wheel to scroll',
            {
                viewer: summarizeViewerStateForLog(),
                wheel: summarizeWheelEventForDebug(interaction.event),
            },
        );
        cancelPendingSearchScroll();
        return true;
    }

    function routeModifierWheelZoom(interaction: IDocumentWheelInteraction) {
        if (!handleViewerModifierWheelZoom(interaction)) {
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

    function suppressWheelDuringActiveZoom(event: IDocumentWheelSourceEvent, context: IWheelDispatchContext) {
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

    function handleViewerModifierWheelZoom(interaction: IDocumentWheelInteraction) {
        const { event } = interaction;
        const nowMs = Date.now();
        const debugId = ++zoomDebugWheelEventId;
        const wheelIntent = getModifierWheelIntent(interaction, nowMs);
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

        const delta = interaction.deltaPx;
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

        // Capture committed pixels before the reactive scale mutation can
        // clear or replace renderer canvases. The rerender coordinator also
        // captures at its boundary, but that is intentionally downstream of
        // this synchronous wheel packet and is too late to cover the first
        // geometry frame of a rapid modifier-wheel gesture.
        captureZoomVisualSnapshots?.();
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

    function handleViewerWheel(interaction: IDocumentWheelInteraction) {
        const { event } = interaction;
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
            routePlatformModifiedWheelToScroll(interaction)
            || routeModifierWheelZoom(interaction)
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
