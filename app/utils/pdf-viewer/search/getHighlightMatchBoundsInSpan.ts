import type { IPdfSearchHighlightMatchRange } from '@app/utils/pdf-viewer/search/pdfSearchHighlightMatchRange';

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
