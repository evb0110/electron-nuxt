import {
    getPdfLayerVisualSnapshotAnnotationEditorLayer,
    getPdfLayerVisualSnapshotAnnotationLayer,
    getPdfLayerVisualSnapshotCanvasHost,
    isPdfLayerVisualElementPotentiallyPainted,
    isPdfLayerVisualSnapshotElement,
    isPdfLayerVisualSnapshotSourceElement,
    queryPdfLayerVisualSnapshotElements,
} from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotDom';

const DRAW_LAYER_VISUAL_SELECTOR = [
    ':scope > svg.highlight',
    ':scope > svg.highlightOutline',
    ':scope > svg.draw',
    ':scope > svg.pdf-highlight-composite-overlay',
].join(', ');

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

function isElementReadyForSnapshotRelease(element: Element) {
    if (
        isPdfLayerVisualSnapshotElement(element)
        || isPdfLayerVisualSnapshotSourceElement(element)
    ) {
        return false;
    }
    return isPdfLayerVisualElementPotentiallyPainted(element, {ignoreActiveSnapshotHostVisibility: true});
}

function hasAnnotationLayerReleaseContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return queryPdfLayerVisualSnapshotElements(layer, ANNOTATION_LAYER_VISUAL_SELECTOR)
        .some(isElementReadyForSnapshotRelease);
}

function hasAnnotationEditorLayerReleaseContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return getChildren(layer)
        .some(isElementReadyForSnapshotRelease);
}

function hasPdfDrawLayerReleaseContent(canvasHost: HTMLElement | null | undefined) {
    if (!canvasHost) {
        return false;
    }

    return queryPdfLayerVisualSnapshotElements<SVGElement>(
        canvasHost,
        DRAW_LAYER_VISUAL_SELECTOR,
    ).some(isElementReadyForSnapshotRelease);
}

export function hasPdfPageAnnotationVisualContentForSnapshotRelease(
    pageContainer: HTMLElement | null | undefined,
) {
    return (
        hasPdfDrawLayerReleaseContent(getPdfLayerVisualSnapshotCanvasHost(pageContainer))
        || hasAnnotationLayerReleaseContent(getPdfLayerVisualSnapshotAnnotationLayer(pageContainer))
        || hasAnnotationEditorLayerReleaseContent(getPdfLayerVisualSnapshotAnnotationEditorLayer(pageContainer))
    );
}
