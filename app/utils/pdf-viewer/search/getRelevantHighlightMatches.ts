import type { IPdfSearchHighlightMatchRange } from '@app/utils/pdf-viewer/search/pdfSearchHighlightMatchRange';

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
