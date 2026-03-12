import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdf';
import {
    buildTextLayerIndex,
    buildRunMatchOverlaps,
    highlightTextInSpan,
    clearDomHighlights,
    scrollToHighlight,
} from '@app/composables/pdfSearchHighlightDom';
import {
    canUseHighlightAPI,
    getHighlightMode,
    createHighlightRangesInSpan,
    createCssHighlightState,
    updateHighlightAPI,
    registerHighlightRange,
    clearHighlightAPIForLayer,
} from '@app/composables/pdfSearchHighlightCss';

const HIGHLIGHT_CLASS = 'pdf-search-highlight';
const HIGHLIGHT_CURRENT_CLASS = 'pdf-search-highlight--current';

const HIGHLIGHT_API_NAME = 'pdf-search-match';
const HIGHLIGHT_API_CURRENT_NAME = 'pdf-search-current-match';

export interface IHighlightResult {
    elements: HTMLElement[];
    currentMatchElements: HTMLElement[];
    currentMatchRanges: Range[];
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
            return {
                elements: [],
                currentMatchElements: [],
                currentMatchRanges: [],
            };
        }

        const {
            text: layerText,
            runs,
        } = buildTextLayerIndex(textLayerDiv);

        const matchesWithCurrent = pageMatches.matches
            .map((match, index) => ({
                start: match.start,
                end: match.end,
                isCurrent: currentMatch !== null
                    && currentMatch.pageIndex === pageMatches.pageIndex
                    && (
                        currentMatch.pageMatchIndex === index
                        || currentMatch.matchIndex === match.matchIndex
                    ),
            }))
            .filter(match => match.end > match.start && match.end <= layerText.length);

        if (matchesWithCurrent.length === 0) {
            return {
                elements: [],
                currentMatchElements: [],
                currentMatchRanges: [],
            };
        }

        const runOverlaps = buildRunMatchOverlaps(runs, matchesWithCurrent);

        if (canUseHighlightAPI() && getHighlightMode() === 'css') {
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
                    const id = `pdf-${pageMatches.pageIndex}-${run.startOffset}-${idx}-${isCurrent ? 'c' : 'n'}`;
                    registerHighlightRange(cssState, textLayerDiv, range, isCurrent, id);
                    if (isCurrent) {
                        currentRanges.push(range);
                    }
                });
            }

            cssState.layerCurrentRanges.set(textLayerDiv, currentRanges);
            updateHighlightAPI(cssState, HIGHLIGHT_API_NAME, HIGHLIGHT_API_CURRENT_NAME);

            return {
                elements: [],
                currentMatchElements: [],
                currentMatchRanges: currentRanges,
            };
        }

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

            elements.forEach((element) => {
                if (element.classList.contains(HIGHLIGHT_CURRENT_CLASS)) {
                    currentMatchElements.push(element);
                }
            });
        }

        return {
            elements: allHighlightElements,
            currentMatchElements,
            currentMatchRanges: [],
        };
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
