import { hasPdfPageDrawLayerVisualContent } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/hasPdfPageDrawLayerVisualContent';
import {
    getPdfLayerVisualSnapshotAnnotationEditorLayer,
    getPdfLayerVisualSnapshotAnnotationLayer,
    isPdfLayerVisualElementVisiblyPainted,
    queryPdfLayerVisualSnapshotElements,
} from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotDom';

const ANNOTATION_LAYER_VISUAL_SELECTOR = [
    '.editorAnnotation',
    '.highlightAnnotation',
    '.underlineAnnotation',
    '.strikeoutAnnotation',
    '.squigglyAnnotation',
    '[data-annotation-id]',
].join(', ');

function getChildren(element: Element | null | undefined) {
    return element?.children
        ? Array.from(element.children)
        : [];
}

function hasAnnotationLayerVisualContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return queryPdfLayerVisualSnapshotElements(layer, ANNOTATION_LAYER_VISUAL_SELECTOR)
        .some(isPdfLayerVisualElementVisiblyPainted);
}

function hasAnnotationEditorLayerVisualContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return getChildren(layer)
        .some(isPdfLayerVisualElementVisiblyPainted);
}

export function hasPdfPageAnnotationVisualContent(
    pageContainer: HTMLElement | null | undefined,
) {
    return (
        hasPdfPageDrawLayerVisualContent(pageContainer)
        || hasAnnotationLayerVisualContent(getPdfLayerVisualSnapshotAnnotationLayer(pageContainer))
        || hasAnnotationEditorLayerVisualContent(getPdfLayerVisualSnapshotAnnotationEditorLayer(pageContainer))
    );
}
