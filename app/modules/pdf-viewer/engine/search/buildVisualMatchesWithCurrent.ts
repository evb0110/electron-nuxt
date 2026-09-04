import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import {
    assembleSearchablePageText,
    buildPdfSearchRegex,
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

function buildLayerSearchMatches(
    pageMatches: IPdfPageMatches,
    assembledLayerText: IAssembledSearchablePageText,
): IVisualSearchMatch[] {
    if (!pageMatches.searchQuery) {
        return [];
    }

    let pattern: RegExp;
    try {
        pattern = buildPdfSearchRegex(pageMatches.searchQuery, {
            matchCase: pageMatches.searchOptions?.matchCase ?? false,
            wholeWord: pageMatches.searchOptions?.wholeWord ?? false,
            useRegex: pageMatches.searchOptions?.useRegex ?? false,
        });
    } catch {
        return [];
    }

    const occurrences = [...assembledLayerText.text.matchAll(pattern)]
        .filter(match => (match[0]?.length ?? 0) > 0 && match.index !== undefined);
    const canUseBackendIdentity = occurrences.length === pageMatches.matches.length;
    return occurrences
        .flatMap((match, index): IVisualSearchMatch[] => {
            const backendMatch = pageMatches.matches[index];
            if (match.index === undefined) {
                return [];
            }
            const mapped = mapAssembledSearchablePageTextRange(assembledLayerText, {
                startOffset: match.index,
                endOffset: match.index + match[0].length,
            });
            if (!mapped) {
                return [];
            }
            return [{
                start: mapped.startOffset,
                end: mapped.endOffset,
                matchIndex: backendMatch?.matchIndex ?? index,
                pageMatchIndex: index,
                canUseBackendIdentity: canUseBackendIdentity && backendMatch !== undefined,
            }];
        });
}

function backendMatchesPointAtDistinctLayerOccurrences(
    backendMatches: IVisualSearchMatch[],
    layerMatches: IVisualSearchMatch[],
) {
    const remainingLayerRanges = new Map<string, number>();
    for (const layerMatch of layerMatches) {
        const key = `${String(layerMatch.start)}:${String(layerMatch.end)}`;
        remainingLayerRanges.set(key, (remainingLayerRanges.get(key) ?? 0) + 1);
    }

    return backendMatches.every((backendMatch) => {
        const key = `${String(backendMatch.start)}:${String(backendMatch.end)}`;
        const remaining = remainingLayerRanges.get(key) ?? 0;
        if (remaining === 0) {
            return false;
        }
        remainingLayerRanges.set(key, remaining - 1);
        return true;
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

function arePageMatchesInSearchOrder(pageMatches: IPdfPageMatches) {
    return pageMatches.matches.every((match, index) => (
        index === 0
        || match.start >= pageMatches.matches[index - 1]!.start
    ));
}

function getFallbackCurrentMatchIndex(
    matches: IVisualSearchMatch[],
    pageMatches: IPdfPageMatches,
    currentMatch: IPdfSearchMatch | null,
) {
    if (!currentMatch || matches.length === 0) {
        return -1;
    }

    const requestedPageMatchIndex = currentMatch.pageMatchIndex;
    // Equal counts preserve the page-local ordinal across extraction drift,
    // provided the native result order is still document order.
    if (
        matches.length === pageMatches.matches.length
        && arePageMatchesInSearchOrder(pageMatches)
        && typeof requestedPageMatchIndex === 'number'
        && Number.isSafeInteger(requestedPageMatchIndex)
    ) {
        return Math.min(matches.length - 1, Math.max(0, requestedPageMatchIndex));
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
        const fallbackIndex = getFallbackCurrentMatchIndex(matches, pageMatches, currentMatch);
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
    const layerMatches = buildLayerSearchMatches(pageMatches, assembledLayerText);
    const backendMatches = buildBackendVisualMatches(pageMatches, assembledLayerText);
    const backendMatchesPointAtLayerOccurrences = !pageMatches.searchQuery
        || backendMatchesPointAtDistinctLayerOccurrences(backendMatches, layerMatches);
    const matches = backendMatches.length === pageMatches.matches.length
        && backendMatchesPointAtLayerOccurrences
        ? backendMatches
        : layerMatches.map(match => ({
            ...match,
            canUseBackendIdentity: false,
        }));
    return markVisualMatchesWithCurrent(matches, pageMatches, currentMatch);
}
