export interface IPdfSearchHighlightMatchRange {
    start: number;
    end: number;
    isCurrent: boolean;
}

export function getRelevantHighlightMatches(
    textLength: number,
    spanStartOffset: number,
    matches: IPdfSearchHighlightMatchRange[],
    precomputedMatches?: IPdfSearchHighlightMatchRange[],
) {
    const spanEndOffset = spanStartOffset + textLength;

    return precomputedMatches
        ?? matches.filter(
            match => match.start < spanEndOffset && match.end > spanStartOffset,
        );
}

export function getHighlightMatchBoundsInSpan(
    textLength: number,
    spanStartOffset: number,
    match: IPdfSearchHighlightMatchRange,
) {
    return {
        start: Math.max(0, match.start - spanStartOffset),
        end: Math.min(textLength, match.end - spanStartOffset),
    };
}
