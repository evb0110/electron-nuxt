import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdf';
import { findPdfSearchMatches } from '@contracts/search';
import {
    buildRunMatchOverlaps,
    getCachedTextLayerIndex,
    highlightTextInSpan,
    clearDomHighlights,
    scrollToHighlight,
    type IHighlightMatchRange,
    type TTextLayerRun,
} from '@app/composables/pdfSearchHighlightDom';
import {
    canUseHighlightAPI,
    getHighlightMode,
    createHighlightRangesInSpan,
    createCssHighlightState,
    updateHighlightAPI,
    registerHighlightRange,
    clearHighlightAPIForLayer,
    type ICssHighlightState,
} from '@app/composables/pdfSearchHighlightCss';

const HIGHLIGHT_CLASS = 'pdf-search-highlight';
const HIGHLIGHT_CURRENT_CLASS = 'pdf-search-highlight--current';

const HIGHLIGHT_API_NAME = 'pdf-searchMatch';
const HIGHLIGHT_API_CURRENT_NAME = 'pdf-search-current-match';

interface IVisualSearchMatch {
    start: number;
    end: number;
    matchIndex: number;
    pageMatchIndex: number;
}

export interface IHighlightResult {
    elements: HTMLElement[];
    currentMatchElements: HTMLElement[];
    currentMatchRanges: Range[];
}

function createHighlightResult(overrides: Partial<IHighlightResult> = {}): IHighlightResult {
    return {
        elements: overrides.elements ?? [],
        currentMatchElements: overrides.currentMatchElements ?? [],
        currentMatchRanges: overrides.currentMatchRanges ?? [],
    };
}

function buildBackendVisualMatches(
    pageMatches: IPdfPageMatches,
    layerTextLength: number,
): IVisualSearchMatch[] {
    return pageMatches.matches
        .map((match, index): IVisualSearchMatch => ({
            start: match.start,
            end: match.end,
            matchIndex: match.matchIndex,
            pageMatchIndex: index,
        }))
        .filter(match => match.end > match.start && match.end <= layerTextLength);
}

function buildLayerSearchVisualMatches(
    pageMatches: IPdfPageMatches,
    layerText: string,
): IVisualSearchMatch[] {
    const query = pageMatches.searchQuery.trim();
    if (!query) {
        return [];
    }

    try {
        return findPdfSearchMatches(layerText, query, {
            matchCase: Boolean(pageMatches.searchOptions?.matchCase),
            wholeWord: Boolean(pageMatches.searchOptions?.wholeWord),
            useRegex: Boolean(pageMatches.searchOptions?.useRegex),
        }).map((match, index): IVisualSearchMatch => ({
            start: match.startOffset,
            end: match.endOffset,
            matchIndex: pageMatches.matches[index]?.matchIndex ?? index,
            pageMatchIndex: index,
        }));
    } catch {
        return [];
    }
}

function isLiteralOffsetCompatible(
    layerText: string,
    match: IVisualSearchMatch,
    pageMatches: IPdfPageMatches,
) {
    if (pageMatches.searchOptions?.useRegex) {
        return true;
    }

    const actual = layerText.slice(match.start, match.end);
    const expected = pageMatches.searchQuery;
    return pageMatches.searchOptions?.matchCase
        ? actual === expected
        : actual.toLowerCase() === expected.toLowerCase();
}

function shouldUseLayerSearchMatches(
    backendMatches: IVisualSearchMatch[],
    pageMatches: IPdfPageMatches,
    layerText: string,
) {
    if (backendMatches.length !== pageMatches.matches.length) {
        return true;
    }

    return backendMatches.some(match => !isLiteralOffsetCompatible(layerText, match, pageMatches));
}

function isCurrentVisualMatch(
    match: IVisualSearchMatch,
    pageMatches: IPdfPageMatches,
    currentMatch: IPdfSearchMatch | null,
) {
    return currentMatch !== null
        && currentMatch.pageIndex === pageMatches.pageIndex
        && (
            currentMatch.pageMatchIndex === match.pageMatchIndex
            || currentMatch.matchIndex === match.matchIndex
        );
}

function getFallbackCurrentMatchIndex(
    matches: IVisualSearchMatch[],
    currentMatch: IPdfSearchMatch | null,
) {
    if (!currentMatch || matches.length === 0) {
        return -1;
    }

    const requestedPageMatchIndex = currentMatch.pageMatchIndex;
    if (typeof requestedPageMatchIndex === 'number' && Number.isFinite(requestedPageMatchIndex)) {
        return Math.min(matches.length - 1, Math.max(0, requestedPageMatchIndex));
    }

    return 0;
}

function markVisualMatchesWithCurrent(
    matches: IVisualSearchMatch[],
    pageMatches: IPdfPageMatches,
    currentMatch: IPdfSearchMatch | null,
): IHighlightMatchRange[] {
    const ranges = matches.map((match): IHighlightMatchRange => ({
        start: match.start,
        end: match.end,
        isCurrent: isCurrentVisualMatch(match, pageMatches, currentMatch),
    }));

    const shouldHaveCurrent = currentMatch?.pageIndex === pageMatches.pageIndex;
    if (shouldHaveCurrent && ranges.length > 0 && !ranges.some(match => match.isCurrent)) {
        const fallbackIndex = getFallbackCurrentMatchIndex(matches, currentMatch);
        if (fallbackIndex >= 0) {
            ranges[fallbackIndex] = {
                ...ranges[fallbackIndex]!,
                isCurrent: true,
            };
        }
    }

    return ranges;
}

export function buildVisualMatchesWithCurrent(
    pageMatches: IPdfPageMatches,
    currentMatch: IPdfSearchMatch | null,
    layerText: string,
): IHighlightMatchRange[] {
    const backendMatches = buildBackendVisualMatches(pageMatches, layerText.length);
    const layerSearchMatches = shouldUseLayerSearchMatches(backendMatches, pageMatches, layerText)
        ? buildLayerSearchVisualMatches(pageMatches, layerText)
        : [];
    const visualMatches = layerSearchMatches.length > 0
        ? layerSearchMatches
        : backendMatches;

    return markVisualMatchesWithCurrent(visualMatches, pageMatches, currentMatch);
}

function renderCssHighlights(
    cssState: ICssHighlightState,
    textLayerDiv: HTMLElement,
    pageIndex: number,
    runs: TTextLayerRun[],
    matchesWithCurrent: IHighlightMatchRange[],
    runOverlaps: IHighlightMatchRange[][],
): IHighlightResult {
    const currentRanges: Range[] = [];

    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
        const run = runs[runIndex]!;
        if (run.kind !== 'span' || !run.textNode) {
            continue;
        }

        const overlaps = runOverlaps[runIndex];
        if (!overlaps || overlaps.length === 0) {
            continue;
        }

        const ranges = createHighlightRangesInSpan(
            run.textNode,
            run.startOffset,
            matchesWithCurrent,
            overlaps,
        );
        ranges.forEach((rangeEntry, idx) => {
            const {
                range,
                isCurrent,
            } = rangeEntry;
            const id = `pdf-${pageIndex}-${run.startOffset}-${idx}-${isCurrent ? 'c' : 'n'}`;
            registerHighlightRange(cssState, textLayerDiv, range, isCurrent, id);
            if (isCurrent) {
                currentRanges.push(range);
            }
        });
    }

    cssState.layerCurrentRanges.set(textLayerDiv, currentRanges);
    updateHighlightAPI(cssState, HIGHLIGHT_API_NAME, HIGHLIGHT_API_CURRENT_NAME);

    return createHighlightResult({ currentMatchRanges: currentRanges });
}

function collectCurrentMatchElements(elements: HTMLElement[]) {
    return elements.filter(element => element.classList.contains(HIGHLIGHT_CURRENT_CLASS));
}

function renderDomHighlights(
    runs: TTextLayerRun[],
    matchesWithCurrent: IHighlightMatchRange[],
    runOverlaps: IHighlightMatchRange[][],
): IHighlightResult {
    const allHighlightElements: HTMLElement[] = [];
    const currentMatchElements: HTMLElement[] = [];

    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
        const run = runs[runIndex]!;
        if (run.kind !== 'span') {
            continue;
        }

        const overlaps = runOverlaps[runIndex];
        if (!overlaps || overlaps.length === 0) {
            continue;
        }

        const elements = highlightTextInSpan(
            run.span,
            run.startOffset,
            matchesWithCurrent,
            HIGHLIGHT_CLASS,
            HIGHLIGHT_CURRENT_CLASS,
            overlaps,
        );
        allHighlightElements.push(...elements);
        currentMatchElements.push(...collectCurrentMatchElements(elements));
    }

    return createHighlightResult({
        elements: allHighlightElements,
        currentMatchElements,
    });
}

export const usePdfSearchHighlight = () => {
    const cssState = createCssHighlightState();

    function clearHighlights(container: HTMLElement) {
        clearHighlightAPIForLayer(cssState, container, HIGHLIGHT_API_NAME, HIGHLIGHT_API_CURRENT_NAME);
        clearDomHighlights(container, HIGHLIGHT_CLASS);
    }

    function highlightPage(
        textLayerDiv: HTMLElement,
        pageMatches: IPdfPageMatches | null,
        currentMatch: IPdfSearchMatch | null,
    ): IHighlightResult {
        clearHighlights(textLayerDiv);

        if (!pageMatches || pageMatches.matches.length === 0) {
            return createHighlightResult();
        }

        const {
            text: layerText,
            runs,
        } = getCachedTextLayerIndex(textLayerDiv);

        const matchesWithCurrent = buildVisualMatchesWithCurrent(pageMatches, currentMatch, layerText);

        if (matchesWithCurrent.length === 0) {
            return createHighlightResult();
        }

        const runOverlaps = buildRunMatchOverlaps(runs, matchesWithCurrent);

        if (canUseHighlightAPI() && getHighlightMode() === 'css') {
            return renderCssHighlights(
                cssState,
                textLayerDiv,
                pageMatches.pageIndex,
                runs,
                matchesWithCurrent,
                runOverlaps,
            );
        }

        return renderDomHighlights(runs, matchesWithCurrent, runOverlaps);
    }

    function getCurrentMatchRanges(textLayerDiv: HTMLElement): Range[] {
        return cssState.layerCurrentRanges.get(textLayerDiv) ?? [];
    }

    return {
        clearHighlights,
        highlightPage,
        scrollToHighlight,
        getCurrentMatchRanges,
        HIGHLIGHT_CLASS,
        HIGHLIGHT_CURRENT_CLASS,
    };
};
