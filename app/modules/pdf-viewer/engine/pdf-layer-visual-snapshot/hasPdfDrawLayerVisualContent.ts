import {
    isPdfLayerVisualElementVisiblyPainted,
    queryPdfLayerVisualSnapshotElements,
} from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotDom';

const DRAW_LAYER_VISUAL_SELECTOR = [
    ':scope > svg.highlight',
    ':scope > svg.highlightOutline',
    ':scope > svg.draw',
    ':scope > svg.pdf-highlight-composite-overlay',
].join(', ');

export function hasPdfDrawLayerVisualContent(canvasHost: HTMLElement | null | undefined) {
    if (!canvasHost) {
        return false;
    }

    return queryPdfLayerVisualSnapshotElements<SVGElement>(
        canvasHost,
        DRAW_LAYER_VISUAL_SELECTOR,
    ).some(isPdfLayerVisualElementVisiblyPainted);
}
