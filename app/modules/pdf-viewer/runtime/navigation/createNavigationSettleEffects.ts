import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisor,
    type IPdfRenderSupervisorTimer,
    type TPdfRenderSupervisorWatchdogCause,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';

type TContinuousLayoutReapplyReason = 'mutation' | 'resize' | 'scroll';

interface IContinuousLayoutReapplyEvent {
    pageNumber: number;
    reason: TContinuousLayoutReapplyReason;
    runId: number;
    scrollOptions?: IScrollToPageOptions | undefined;
}

interface IPagedNavigationHoldWatchdogEvent {
    cause: TPdfRenderSupervisorWatchdogCause;
    delayMs: number;
    runId: number;
    targetPage: number;
}

interface IArmPagedNavigationHoldWatchdogOptions {
    abandonMs: number;
    recoveryRenderMs: number;
    readyRetryDelaysMs: readonly number[];
    runId: number;
    stallLogMs: number;
    targetPage: number;
    onAbandon: (event: IPagedNavigationHoldWatchdogEvent) => void;
    onReadyRetry: (event: IPagedNavigationHoldWatchdogEvent) => void;
    onRecovery: (event: IPagedNavigationHoldWatchdogEvent) => void;
    onStillWaiting: (event: IPagedNavigationHoldWatchdogEvent) => void;
}

interface ICreateNavigationSettleEffectsDeps {
    getLayoutObserverElements: (pageNumber: number) => HTMLElement[];
    hasLayoutMutation: (mutations: MutationRecord[], pageNumber: number) => boolean;
    onLayoutReapply: (event: IContinuousLayoutReapplyEvent) => void;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
}

export function createNavigationSettleEffects(deps: ICreateNavigationSettleEffectsDeps) {
    const renderSupervisor = deps.renderSupervisor ?? createPdfRenderSupervisor();
    let pagedNavigationSettleTimer: IPdfRenderSupervisorTimer | null = null;
    let searchNavigationSettleTimer: IPdfRenderSupervisorTimer | null = null;
    let continuousNavigationRenderTimers: IPdfRenderSupervisorTimer[] = [];
    let continuousNavigationTargetClearTimer: IPdfRenderSupervisorTimer | null = null;
    let pagedNavigationReadyRetryTimers: IPdfRenderSupervisorTimer[] = [];
    let pagedNavigationRecoveryRenderTimer: IPdfRenderSupervisorTimer | null = null;
    let pagedNavigationAbandonTimer: IPdfRenderSupervisorTimer | null = null;
    let pagedNavigationStillWaitingTimer: IPdfRenderSupervisorTimer | null = null;
    let continuousNavigationLayoutObserver: MutationObserver | null = null;
    let continuousNavigationResizeObserver: ResizeObserver | null = null;
    let continuousNavigationResizeObservedElements: HTMLElement[] = [];
    let isContinuousNavigationLayoutReapplyQueued = false;
    let pendingContinuousNavigationLayoutReapplyEvent: IContinuousLayoutReapplyEvent | null = null;

    function clearPagedSettle() {
        renderSupervisor.clearTimer(pagedNavigationSettleTimer);
        pagedNavigationSettleTimer = null;
    }

    function armPagedSettle(
        runId: number,
        pageNumber: number,
        ms: number,
        onSettle: (runId: number, pageNumber: number) => void,
    ) {
        clearPagedSettle();
        pagedNavigationSettleTimer = renderSupervisor.armTimer({
            cause: 'navigation-paged-settle',
            delayMs: ms,
            key: 'navigation-paged-settle',
            metadata: {
                pageNumber,
                runId,
            },
            onFire: () => {
                pagedNavigationSettleTimer = null;
                onSettle(runId, pageNumber);
            },
        });
    }

    function clearPagedHoldWatchdog() {
        renderSupervisor.clearTimers(pagedNavigationReadyRetryTimers);
        pagedNavigationReadyRetryTimers = [];
        renderSupervisor.clearTimer(pagedNavigationRecoveryRenderTimer);
        pagedNavigationRecoveryRenderTimer = null;
        renderSupervisor.clearTimer(pagedNavigationAbandonTimer);
        pagedNavigationAbandonTimer = null;
        renderSupervisor.clearTimer(pagedNavigationStillWaitingTimer);
        pagedNavigationStillWaitingTimer = null;
    }

    function armPagedHoldWatchdog(options: IArmPagedNavigationHoldWatchdogOptions) {
        clearPagedHoldWatchdog();

        const buildEvent = (
            delayMs: number,
            cause: TPdfRenderSupervisorWatchdogCause,
        ): IPagedNavigationHoldWatchdogEvent => ({
            cause,
            delayMs,
            runId: options.runId,
            targetPage: options.targetPage,
        });

        options.readyRetryDelaysMs.forEach((delayMs, index) => {
            const timer = renderSupervisor.armTimer({
                cause: 'navigation-hold-ready-retry',
                delayMs,
                key: `navigation-hold-ready-retry:${index}`,
                metadata: {
                    delayMs,
                    runId: options.runId,
                    targetPage: options.targetPage,
                },
                onFire: () => {
                    pagedNavigationReadyRetryTimers = pagedNavigationReadyRetryTimers
                        .filter(activeTimer => activeTimer !== timer);
                    options.onReadyRetry(buildEvent(delayMs, 'navigation-hold-ready-retry'));
                },
            });
            pagedNavigationReadyRetryTimers.push(timer);
        });

        pagedNavigationRecoveryRenderTimer = renderSupervisor.armTimer({
            cause: 'navigation-hold-recovery',
            delayMs: options.recoveryRenderMs,
            key: 'navigation-hold-recovery',
            metadata: {
                runId: options.runId,
                targetPage: options.targetPage,
            },
            onFire: () => {
                pagedNavigationRecoveryRenderTimer = null;
                options.onRecovery(buildEvent(options.recoveryRenderMs, 'navigation-hold-recovery'));
            },
        });

        pagedNavigationAbandonTimer = renderSupervisor.armTimer({
            cause: 'navigation-hold-abandon',
            delayMs: options.abandonMs,
            key: 'navigation-hold-abandon',
            metadata: {
                runId: options.runId,
                targetPage: options.targetPage,
            },
            onFire: () => {
                pagedNavigationAbandonTimer = null;
                options.onAbandon(buildEvent(options.abandonMs, 'navigation-hold-abandon'));
            },
        });

        pagedNavigationStillWaitingTimer = renderSupervisor.armTimer({
            cause: 'navigation-hold-still-waiting',
            delayMs: options.stallLogMs,
            key: 'navigation-hold-still-waiting',
            metadata: {
                runId: options.runId,
                targetPage: options.targetPage,
            },
            onFire: () => {
                pagedNavigationStillWaitingTimer = null;
                options.onStillWaiting(buildEvent(options.stallLogMs, 'navigation-hold-still-waiting'));
            },
        });
    }

    function clearSearchSettle() {
        renderSupervisor.clearTimer(searchNavigationSettleTimer);
        searchNavigationSettleTimer = null;
    }

    function armSearchSettle(ms: number, onSettle: () => void) {
        clearSearchSettle();
        searchNavigationSettleTimer = renderSupervisor.armTimer({
            cause: 'navigation-search-settle',
            delayMs: ms,
            key: 'navigation-search-settle',
            onFire: () => {
                searchNavigationSettleTimer = null;
                onSettle();
            },
        });
    }

    function clearContinuousRenderTimers() {
        renderSupervisor.clearTimers(continuousNavigationRenderTimers);
        continuousNavigationRenderTimers = [];
    }

    function hasContinuousRenderTimers() {
        return continuousNavigationRenderTimers.length > 0;
    }

    function armContinuousRender(
        delaysMs: readonly number[],
        onRender: (delayMs: number) => void,
    ) {
        clearContinuousRenderTimers();
        delaysMs.forEach((delayMs, index) => {
            const timer = renderSupervisor.armTimer({
                cause: 'navigation-continuous-render',
                delayMs,
                key: `navigation-continuous-render:${index}`,
                metadata: { delayMs },
                onFire: () => {
                    continuousNavigationRenderTimers = continuousNavigationRenderTimers
                        .filter(activeTimer => activeTimer !== timer);
                    onRender(delayMs);
                },
            });
            continuousNavigationRenderTimers.push(timer);
        });
    }

    function clearContinuousTargetFallback() {
        renderSupervisor.clearTimer(continuousNavigationTargetClearTimer);
        continuousNavigationTargetClearTimer = null;
    }

    function armContinuousTargetFallback(
        ms: number,
        onClear: () => void,
    ) {
        clearContinuousTargetFallback();
        continuousNavigationTargetClearTimer = renderSupervisor.armTimer({
            cause: 'navigation-continuous-target-fallback',
            delayMs: ms,
            key: 'navigation-continuous-target-fallback',
            onFire: () => {
                continuousNavigationTargetClearTimer = null;
                onClear();
            },
        });
    }

    function setContinuousNavigationResizeObserverElements(elements: HTMLElement[]) {
        const observer = continuousNavigationResizeObserver;
        if (!observer) {
            return;
        }

        if (
            elements.length === continuousNavigationResizeObservedElements.length
            && elements.every((element, index) => (
                element === continuousNavigationResizeObservedElements[index]
            ))
        ) {
            return;
        }

        observer.disconnect();
        for (const element of elements) {
            observer.observe(element);
        }
        continuousNavigationResizeObservedElements = elements;
    }

    function refreshContinuousNavigationResizeObserverTarget(pageNumber: number) {
        setContinuousNavigationResizeObserverElements(
            deps.getLayoutObserverElements(pageNumber),
        );
    }

    function scheduleLayoutReapply(
        runId: number,
        pageNumber: number,
        reason: TContinuousLayoutReapplyReason,
        scrollOptions?: IScrollToPageOptions,
    ) {
        const event: IContinuousLayoutReapplyEvent = {
            pageNumber,
            reason,
            runId,
            scrollOptions,
        };
        const flush = () => {
            const pending = pendingContinuousNavigationLayoutReapplyEvent;
            pendingContinuousNavigationLayoutReapplyEvent = null;
            isContinuousNavigationLayoutReapplyQueued = false;
            if (pending) {
                deps.onLayoutReapply(pending);
            }
        };

        if (isContinuousNavigationLayoutReapplyQueued) {
            if (reason === 'mutation' || reason === 'resize') {
                pendingContinuousNavigationLayoutReapplyEvent = event;
                flush();
            }
            return;
        }

        pendingContinuousNavigationLayoutReapplyEvent = event;
        isContinuousNavigationLayoutReapplyQueued = true;

        if (reason === 'mutation' || reason === 'resize') {
            flush();
            return;
        }

        void nextTick(flush);
    }

    function clearLayoutObservers() {
        continuousNavigationLayoutObserver?.disconnect();
        continuousNavigationLayoutObserver = null;
        continuousNavigationResizeObserver?.disconnect();
        continuousNavigationResizeObserver = null;
        continuousNavigationResizeObservedElements = [];
        isContinuousNavigationLayoutReapplyQueued = false;
        pendingContinuousNavigationLayoutReapplyEvent = null;
    }

    function attachLayoutObservers(
        runId: number,
        pageNumber: number,
        scrollOptions?: IScrollToPageOptions,
    ) {
        clearLayoutObservers();

        if (typeof ResizeObserver !== 'undefined') {
            continuousNavigationResizeObserver = new ResizeObserver(() => {
                scheduleLayoutReapply(runId, pageNumber, 'resize', scrollOptions);
            });
            refreshContinuousNavigationResizeObserverTarget(pageNumber);
        }

        if (typeof MutationObserver === 'undefined') {
            return;
        }

        continuousNavigationLayoutObserver = new MutationObserver((mutations) => {
            if (!deps.hasLayoutMutation(mutations, pageNumber)) {
                return;
            }

            refreshContinuousNavigationResizeObserverTarget(pageNumber);
            scheduleLayoutReapply(runId, pageNumber, 'mutation', scrollOptions);
        });
        const container = deps.getLayoutObserverElements(pageNumber)[0] ?? null;
        if (!container) {
            return;
        }
        continuousNavigationLayoutObserver.observe(container, {
            attributes: true,
            attributeFilter: [
                'class',
                'data-page',
                'style',
            ],
            childList: true,
            subtree: true,
        });
    }

    function clearContinuous() {
        clearContinuousRenderTimers();
        clearContinuousTargetFallback();
        clearLayoutObservers();
    }

    function disposeAll() {
        clearPagedSettle();
        clearPagedHoldWatchdog();
        clearSearchSettle();
        clearContinuous();
    }

    return {
        armPagedSettle,
        armPagedHoldWatchdog,
        armSearchSettle,
        armContinuousRender,
        armContinuousTargetFallback,
        attachLayoutObservers,
        scheduleLayoutReapply,
        clearPagedSettle,
        clearPagedHoldWatchdog,
        clearSearchSettle,
        clearContinuousRenderTimers,
        clearContinuousTargetFallback,
        clearLayoutObservers,
        clearContinuous,
        hasContinuousRenderTimers,
        disposeAll,
    };
}
