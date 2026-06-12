import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';

type TContinuousLayoutReapplyReason = 'mutation' | 'resize' | 'scroll';

interface IContinuousLayoutReapplyEvent {
    pageNumber: number;
    reason: TContinuousLayoutReapplyReason;
    runId: number;
    scrollOptions?: IScrollToPageOptions | undefined;
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
    let continuousNavigationLayoutObserver: MutationObserver | null = null;
    let continuousNavigationResizeObserver: ResizeObserver | null = null;
    let continuousNavigationResizeObservedElements: HTMLElement[] = [];
    let isContinuousNavigationLayoutReapplyQueued = false;

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
        if (isContinuousNavigationLayoutReapplyQueued) {
            return;
        }

        isContinuousNavigationLayoutReapplyQueued = true;
        void nextTick(() => {
            isContinuousNavigationLayoutReapplyQueued = false;
            deps.onLayoutReapply({
                pageNumber,
                reason,
                runId,
                scrollOptions,
            });
        });
    }

    function clearLayoutObservers() {
        continuousNavigationLayoutObserver?.disconnect();
        continuousNavigationLayoutObserver = null;
        continuousNavigationResizeObserver?.disconnect();
        continuousNavigationResizeObserver = null;
        continuousNavigationResizeObservedElements = [];
        isContinuousNavigationLayoutReapplyQueued = false;
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
        clearSearchSettle();
        clearContinuous();
    }

    return {
        armPagedSettle,
        armSearchSettle,
        armContinuousRender,
        armContinuousTargetFallback,
        attachLayoutObservers,
        scheduleLayoutReapply,
        clearPagedSettle,
        clearSearchSettle,
        clearContinuousRenderTimers,
        clearContinuousTargetFallback,
        clearLayoutObservers,
        clearContinuous,
        hasContinuousRenderTimers,
        disposeAll,
    };
}
