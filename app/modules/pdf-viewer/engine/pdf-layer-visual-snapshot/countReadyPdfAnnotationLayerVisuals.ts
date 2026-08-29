import { pdfLayerVisualSnapshotClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import { pdfLayerVisualSnapshotSourceClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotSourceClass';

const ANNOTATION_VISUAL_LAYER_SELECTOR = [
    '.annotation-layer',
    '.annotationLayer',
    '.annotation-editor-layer',
    '.annotationEditorLayer',
].join(', ');

export function countReadyPdfAnnotationLayerVisuals(
    pageContainer: HTMLElement | null | undefined,
) {
    if (!pageContainer || typeof pageContainer.querySelectorAll !== 'function') {
        return 0;
    }
    return Array.from(pageContainer.querySelectorAll<HTMLElement>(
        ANNOTATION_VISUAL_LAYER_SELECTOR,
    )).filter(layer => !layer.classList.contains(pdfLayerVisualSnapshotClass)).reduce(
        (count, layer) => count + Array.from(layer.children).filter(child => (
            !child.classList.contains(pdfLayerVisualSnapshotSourceClass)
        )).length,
        0,
    );
}
