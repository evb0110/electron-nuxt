import { hasPdfDrawLayerVisualContent } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/hasPdfDrawLayerVisualContent';

function getCanvasHost(pageContainer: HTMLElement | null | undefined) {
    return typeof pageContainer?.querySelector === 'function'
        ? pageContainer.querySelector<HTMLElement>('.page_canvas, .canvasWrapper') ?? null
        : null;
}

export function hasPdfPageDrawLayerVisualContent(
    pageContainer: HTMLElement | null | undefined,
) {
    return hasPdfDrawLayerVisualContent(getCanvasHost(pageContainer));
}
