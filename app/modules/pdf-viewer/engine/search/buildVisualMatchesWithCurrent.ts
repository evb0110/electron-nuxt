import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdf';
import { findPdfSearchMatches } from '@contracts/search';
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
    layerTextLength: number,
): IVisualSearchMatch[] {
    return pageMatches.matches
        .map((match, index): IVisualSearchMatch => ({
            start: match.start,
            end: match.end,
            matchIndex: match.matchIndex,
            pageMatchIndex: index,
            canUseBackendIdentity: true,
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
        const matches = findPdfSearchMatches(layerText, query, {
            matchCase: Boolean(pageMatches.searchOptions?.matchCase),
            wholeWord: Boolean(pageMatches.searchOptions?.wholeWord),
            useRegex: Boolean(pageMatches.searchOptions?.useRegex),
        });
        const canUseBackendIdentity = matches.length === pageMatches.matches.length;

        return matches.map((match, index): IVisualSearchMatch => ({
            start: match.startOffset,
            end: match.endOffset,
            matchIndex: canUseBackendIdentity
                ? pageMatches.matches[index]?.matchIndex ?? index
                : index,
            pageMatchIndex: index,
            canUseBackendIdentity,
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
