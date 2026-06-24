import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';

type TContinuousLayoutReapplyReason = 'mutation' | 'resize' | 'scroll';

interface IContinuousLayoutReapplyEvent {
    pageNumber: number;
    reason: TContinuousLayoutReapplyReason;
    runId: number;
    scrollOptions?: IScrollToPageOptions | undefined;
}

interface IPagedNavigationHoldWatchdogEvent {
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
}

export function createNavigationSettleEffects(deps: ICreateNavigationSettleEffectsDeps) {
    let pagedNavigationSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let searchNavigationSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let continuousNavigationRenderTimers: Array<ReturnType<typeof setTimeout>> = [];
    let continuousNavigationTargetClearTimer: ReturnType<typeof setTimeout> | null = null;
    let pagedNavigationReadyRetryTimers: Array<ReturnType<typeof setTimeout>> = [];
    let pagedNavigationRecoveryRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let pagedNavigationAbandonTimer: ReturnType<typeof setTimeout> | null = null;
    let pagedNavigationStillWaitingTimer: ReturnType<typeof setTimeout> | null = null;
    let continuousNavigationLayoutObserver: MutationObserver | null = null;
    let continuousNavigationResizeObserver: ResizeObserver | null = null;
    let continuousNavigationResizeObservedElements: HTMLElement[] = [];
    let isContinuousNavigationLayoutReapplyQueued = false;
    let pendingContinuousNavigationLayoutReapplyEvent: IContinuousLayoutReapplyEvent | null = null;

    function clearPagedSettle() {
        if (pagedNavigationSettleTimer !== null) {
            clearTimeout(pagedNavigationSettleTimer);
            pagedNavigationSettleTimer = null;
        }
    }

    function armPagedSettle(
        runId: number,
        pageNumber: number,
        ms: number,
        onSettle: (runId: number, pageNumber: number) => void,
    ) {
        clearPagedSettle();
        pagedNavigationSettleTimer = setTimeout(() => {
            pagedNavigationSettleTimer = null;
            onSettle(runId, pageNumber);
        }, ms);
    }

    function clearPagedHoldWatchdog() {
        for (const timer of pagedNavigationReadyRetryTimers) {
            clearTimeout(timer);
        }
        pagedNavigationReadyRetryTimers = [];
        if (pagedNavigationRecoveryRenderTimer !== null) {
            clearTimeout(pagedNavigationRecoveryRenderTimer);
            pagedNavigationRecoveryRenderTimer = null;
        }
        if (pagedNavigationAbandonTimer !== null) {
            clearTimeout(pagedNavigationAbandonTimer);
            pagedNavigationAbandonTimer = null;
        }
        if (pagedNavigationStillWaitingTimer !== null) {
            clearTimeout(pagedNavigationStillWaitingTimer);
            pagedNavigationStillWaitingTimer = null;
        }
    }

    function armPagedHoldWatchdog(options: IArmPagedNavigationHoldWatchdogOptions) {
        clearPagedHoldWatchdog();

        const buildEvent = (delayMs: number): IPagedNavigationHoldWatchdogEvent => ({
            delayMs,
            runId: options.runId,
            targetPage: options.targetPage,
        });

        for (const delayMs of options.readyRetryDelaysMs) {
            const timer = setTimeout(() => {
                pagedNavigationReadyRetryTimers = pagedNavigationReadyRetryTimers
                    .filter(activeTimer => activeTimer !== timer);
                options.onReadyRetry(buildEvent(delayMs));
            }, delayMs);
            pagedNavigationReadyRetryTimers.push(timer);
        }

        pagedNavigationRecoveryRenderTimer = setTimeout(() => {
            pagedNavigationRecoveryRenderTimer = null;
            options.onRecovery(buildEvent(options.recoveryRenderMs));
        }, options.recoveryRenderMs);

        pagedNavigationAbandonTimer = setTimeout(() => {
            pagedNavigationAbandonTimer = null;
            options.onAbandon(buildEvent(options.abandonMs));
        }, options.abandonMs);

        pagedNavigationStillWaitingTimer = setTimeout(() => {
            pagedNavigationStillWaitingTimer = null;
            options.onStillWaiting(buildEvent(options.stallLogMs));
        }, options.stallLogMs);
    }

    function clearSearchSettle() {
        if (searchNavigationSettleTimer !== null) {
            clearTimeout(searchNavigationSettleTimer);
            searchNavigationSettleTimer = null;
        }
    }

    function armSearchSettle(ms: number, onSettle: () => void) {
        clearSearchSettle();
        searchNavigationSettleTimer = setTimeout(() => {
            searchNavigationSettleTimer = null;
            onSettle();
        }, ms);
    }

    function clearContinuousRenderTimers() {
        for (const timer of continuousNavigationRenderTimers) {
            clearTimeout(timer);
        }
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
        for (const delayMs of delaysMs) {
            const timer = setTimeout(() => {
                continuousNavigationRenderTimers = continuousNavigationRenderTimers
                    .filter(activeTimer => activeTimer !== timer);
                onRender(delayMs);
            }, delayMs);
            continuousNavigationRenderTimers.push(timer);
        }
    }

    function clearContinuousTargetFallback() {
        if (continuousNavigationTargetClearTimer !== null) {
            clearTimeout(continuousNavigationTargetClearTimer);
            continuousNavigationTargetClearTimer = null;
        }
    }

    function armContinuousTargetFallback(
        ms: number,
        onClear: () => void,
    ) {
        clearContinuousTargetFallback();
        continuousNavigationTargetClearTimer = setTimeout(() => {
            continuousNavigationTargetClearTimer = null;
            onClear();
        }, ms);
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
