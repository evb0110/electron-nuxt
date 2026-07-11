import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import {
    assembleSearchablePageText,
    mapAssembledSearchablePageTextRange,
} from '@pdf-core';
import type { IAssembledSearchablePageText } from '@contracts/search';
import type { IHighlightMatchRange } from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';

interface IVisualSearchMatch {
    start: number;
    end: number;
    matchIndex: number;
    pageMatchIndex: number;
    canUseBackendIdentity: boolean;
}

function buildBackendVisualMatches(
    pageMatches: IPdfPageMatches,
    assembledLayerText: IAssembledSearchablePageText,
): IVisualSearchMatch[] {
    return pageMatches.matches
        .flatMap((match, index): IVisualSearchMatch[] => {
            const mapped = mapAssembledSearchablePageTextRange(assembledLayerText, {
                startOffset: match.start,
                endOffset: match.end,
            });
            return mapped ? [{
                start: mapped.startOffset,
                end: mapped.endOffset,
                matchIndex: match.matchIndex,
                pageMatchIndex: index,
                canUseBackendIdentity: true,
            }] : [];
        });
}

function isCurrentVisualMatch(
    match: IVisualSearchMatch,
    pageMatches: IPdfPageMatches,
    currentMatch: IPdfSearchMatch | null,
) {
    return currentMatch !== null
        && currentMatch.pageIndex === pageMatches.pageIndex
        && match.canUseBackendIdentity
        && (
            currentMatch.pageMatchIndex === match.pageMatchIndex
            || currentMatch.matchIndex === match.matchIndex
        );
}

function getCurrentMatchOffsetDistance(
    match: IVisualSearchMatch,
    currentMatch: IPdfSearchMatch,
) {
    return Math.abs(match.start - currentMatch.startOffset)
        + Math.abs(match.end - currentMatch.endOffset);
}

function getFallbackCurrentMatchIndex(
    matches: IVisualSearchMatch[],
    currentMatch: IPdfSearchMatch | null,
) {
    if (!currentMatch || matches.length === 0) {
        return -1;
    }

    const shouldUseBackendIdentity = matches.every(match => match.canUseBackendIdentity);
    if (!shouldUseBackendIdentity) {
        return matches.reduce((bestIndex, match, index) => {
            if (bestIndex < 0) {
                return index;
            }

            const bestMatch = matches[bestIndex];
            if (!bestMatch) {
                return index;
            }

            return getCurrentMatchOffsetDistance(match, currentMatch) < getCurrentMatchOffsetDistance(bestMatch, currentMatch)
                ? index
                : bestIndex;
        }, -1);
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
    assembledLayerText = assembleSearchablePageText([{text: layerText}]),
): IHighlightMatchRange[] {
    const backendMatches = buildBackendVisualMatches(pageMatches, assembledLayerText);
    return markVisualMatchesWithCurrent(backendMatches, pageMatches, currentMatch);
}
