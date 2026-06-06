import { extractRectsFromHighlightPath } from '@app/utils/pdf-viewer/pdf-highlight-composite-overlay/extractRectsFromHighlightPath';

export function isRectangularHighlightPathData(pathData: string | null | undefined) {
    return extractRectsFromHighlightPath(pathData) !== null;
}
