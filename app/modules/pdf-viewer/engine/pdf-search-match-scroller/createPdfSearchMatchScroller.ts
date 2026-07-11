interface ICurrentSearchMatchWord {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ICurrentSearchMatch {
    pageIndex: number;
    pageWidth?: number | undefined;
    pageHeight?: number | undefined;
    words?: ICurrentSearchMatchWord[] | undefined;
}

interface ICurrentSearchMatchMarkerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface ISearchNavigationTargetOptions {markerRect?: ICurrentSearchMatchMarkerRect | null | undefined}

interface IPdfSearchMatchScrollerDeps {
    getContainer: () => HTMLElement | null;
    getCurrentSearchMatch: () => ICurrentSearchMatch | null;
    scrollToCurrentMatch: () => boolean;
    scheduleRenderForSinglePage: (pageNumber: number) => void;
    scrollToPage?: (
        pageNumber: number,
        options?: {
            preferExactDom?: boolean;
            navigationSource?: 'search';
        } & ISearchNavigationTargetOptions,
    ) => void;
    suppressSnap?: () => void;
    beginSearchNavigation?: (pageNumber: number) => void;
    revealSearchNavigationTarget?: (
        pageNumber: number,
        options?: ISearchNavigationTargetOptions,
    ) => void;
    endSearchNavigation?: (settleMs?: number) => void;
    beginSearchTransaction?: (
        pageNumber: number,
        options?: ISearchNavigationTargetOptions,
    ) => number | null;
    isSearchTransactionCurrent?: (transactionId: number) => boolean;
    settleSearchTransaction?: (transactionId: number) => void;
    cancelSearchTransaction?: (transactionId: number) => void;
    isPageRenderPending?: (pageNumber: number) => boolean;
}

function clampRatio(value: number) {
    return Math.min(1, Math.max(0, value));
}

function resolveCurrentMatchMarkerRect(
    currentMatch: ICurrentSearchMatch | null,
    targetPageIndex: number,
): ICurrentSearchMatchMarkerRect | null {
    if (
        !currentMatch
        || currentMatch.pageIndex !== targetPageIndex
        || !currentMatch.words?.length
        || !currentMatch.pageWidth
        || !currentMatch.pageHeight
    ) {
        return null;
    }
    const boxes = currentMatch.words.filter(word => (
        Number.isFinite(word.x)
        && Number.isFinite(word.y)
        && Number.isFinite(word.width)
        && Number.isFinite(word.height)
        && word.width > 0
        && word.height > 0
    ));
    if (boxes.length === 0) {
        return null;
    }
    const left = Math.min(...boxes.map(word => word.x));
    const top = Math.min(...boxes.map(word => word.y));
    const right = Math.max(...boxes.map(word => word.x + word.width));
    const bottom = Math.max(...boxes.map(word => word.y + word.height));
    const normalizedLeft = clampRatio(left / currentMatch.pageWidth);
    const normalizedTop = clampRatio(top / currentMatch.pageHeight);
    return {
        left: normalizedLeft,
        top: normalizedTop,
        width: clampRatio(right / currentMatch.pageWidth) - normalizedLeft,
        height: clampRatio(bottom / currentMatch.pageHeight) - normalizedTop,
    };
}

/**
 * Search is now a semantic request producer. ViewportAuthority owns target
 * mounting, text-layer readiness, supersession, placement and highlighting.
 */
export function createPdfSearchMatchScroller(deps: IPdfSearchMatchScrollerDeps) {
    let generation = 0;

    function invalidatePendingRequests() {
        generation += 1;
        deps.endSearchNavigation?.(0);
    }

    function requestScrollToMatch(matchPageIndex: number | null) {
        invalidatePendingRequests();
        if (matchPageIndex === null) {
            return;
        }
        const requestGeneration = generation;
        const pageNumber = matchPageIndex + 1;
        const markerRect = resolveCurrentMatchMarkerRect(
            deps.getCurrentSearchMatch(),
            matchPageIndex,
        );
        if (requestGeneration !== generation) {
            return;
        }
        if (deps.revealSearchNavigationTarget) {
            deps.revealSearchNavigationTarget(pageNumber, markerRect ? {markerRect} : undefined);
            return;
        }
        deps.scrollToPage?.(pageNumber, {
            navigationSource: 'search',
            ...(markerRect ? {markerRect} : {}),
        });
    }

    return {
        requestScrollToMatch,
        invalidatePendingRequests,
    };
}
