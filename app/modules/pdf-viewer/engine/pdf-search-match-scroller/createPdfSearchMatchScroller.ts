import type {
    IPdfSearchExcerpt,
    ISearchMatchOptions,
} from '@contracts/search';
import type {IScrollToPageOptions} from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';

interface ICurrentSearchMatchWord {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ICurrentSearchMatch {
    pageIndex: number;
    pageMatchIndex?: number | undefined;
    matchIndex?: number | undefined;
    startOffset?: number | undefined;
    endOffset?: number | undefined;
    excerpt?: IPdfSearchExcerpt | undefined;
    pageWidth?: number | undefined;
    pageHeight?: number | undefined;
    words?: ICurrentSearchMatchWord[] | undefined;
}

interface ICurrentSearchPageMatches {
    searchQuery: string;
    searchOptions?: ISearchMatchOptions;
    matches?: ReadonlyArray<{start: number}>;
}

interface ICurrentSearchMatchMarkerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

type ISearchNavigationTargetOptions = Pick<IScrollToPageOptions, 'markerRect' | 'textAnchor'>;

interface IPdfSearchMatchScrollerDeps {
    getContainer: () => HTMLElement | null;
    getCurrentSearchMatch: () => ICurrentSearchMatch | null;
    getCurrentSearchPageMatches?: (pageIndex: number) => ICurrentSearchPageMatches | null;
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

function arePageMatchesInSearchOrder(pageMatches: ICurrentSearchPageMatches | null) {
    const matches = pageMatches?.matches;
    return matches !== undefined && matches.every((match, index) => (
        index === 0
        || match.start >= matches[index - 1]!.start
    ));
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

function resolveCurrentMatchTextAnchor(
    currentMatch: ICurrentSearchMatch | null,
    targetPageIndex: number,
    pageMatches: ICurrentSearchPageMatches | null,
): IScrollToPageOptions['textAnchor'] {
    const excerpt = currentMatch?.excerpt;
    const startOffset = currentMatch?.startOffset;
    const endOffset = currentMatch?.endOffset;
    if (
        !currentMatch
        || currentMatch.pageIndex !== targetPageIndex
        || !excerpt?.match
        || typeof startOffset !== 'number'
        || typeof endOffset !== 'number'
        || !Number.isSafeInteger(startOffset)
        || !Number.isSafeInteger(endOffset)
        || startOffset < 0
        || endOffset <= startOffset
    ) {
        return null;
    }

    const expectedPageMatchCount = arePageMatchesInSearchOrder(pageMatches)
        ? pageMatches!.matches!.length
        : undefined;
    return {
        text: excerpt.match,
        ...(excerpt.before ? {prefix: excerpt.before} : {}),
        ...(excerpt.after ? {suffix: excerpt.after} : {}),
        ...(currentMatch.pageMatchIndex === undefined ? {} : {pageMatchIndex: currentMatch.pageMatchIndex}),
        ...(currentMatch.matchIndex === undefined ? {} : {matchIndex: currentMatch.matchIndex}),
        ...(pageMatches?.searchQuery ? {searchQuery: pageMatches.searchQuery} : {}),
        ...(pageMatches?.searchOptions ? {searchOptions: pageMatches.searchOptions} : {}),
        ...(expectedPageMatchCount === undefined ? {} : {expectedPageMatchCount}),
        searchRange: {
            startOffset,
            endOffset,
        },
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
        const currentMatch = deps.getCurrentSearchMatch();
        const pageMatches = deps.getCurrentSearchPageMatches?.(matchPageIndex) ?? null;
        const markerRect = resolveCurrentMatchMarkerRect(
            currentMatch,
            matchPageIndex,
        );
        const textAnchor = markerRect
            ? null
            : resolveCurrentMatchTextAnchor(currentMatch, matchPageIndex, pageMatches);
        const navigationOptions = markerRect
            ? {markerRect}
            : textAnchor
                ? {textAnchor}
                : undefined;
        if (requestGeneration !== generation) {
            return;
        }
        if (deps.revealSearchNavigationTarget) {
            deps.revealSearchNavigationTarget(pageNumber, navigationOptions);
            return;
        }
        deps.scrollToPage?.(pageNumber, {
            navigationSource: 'search',
            ...(navigationOptions ?? {}),
        });
    }

    return {
        requestScrollToMatch,
        invalidatePendingRequests,
    };
}
