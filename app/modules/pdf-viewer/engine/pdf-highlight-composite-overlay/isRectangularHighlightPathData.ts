import { extractRectsFromHighlightPath } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/extractRectsFromHighlightPath';

export function isRectangularHighlightPathData(pathData: string | null | undefined) {
    return extractRectsFromHighlightPath(pathData) !== null;
}
