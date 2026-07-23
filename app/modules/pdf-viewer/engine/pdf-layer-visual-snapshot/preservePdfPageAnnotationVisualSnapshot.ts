import { combinePdfLayerVisualSnapshotReleases } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/combinePdfLayerVisualSnapshotReleases';
import { hasPdfDrawLayerVisualContent } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/hasPdfDrawLayerVisualContent';
import { pdfLayerVisualSnapshotClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import {
    getPdfLayerVisualSnapshotAnnotationEditorLayer,
    getPdfLayerVisualSnapshotAnnotationLayer,
    getPdfLayerVisualSnapshotCanvasHost,
    isPdfLayerVisualElementVisiblyPainted,
    queryPdfLayerVisualSnapshotElements,
} from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotDom';
import { preservePdfDrawLayerVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/preservePdfDrawLayerVisualSnapshot';
import { preservePdfLayerVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/preservePdfLayerVisualSnapshot';

const TEXT_MARKUP_EDITOR_SELECTOR = [
    '.highlightEditor',
    '[role="mark"]',
    '[class*="pdf-markup-subtype"]',
].join(', ');

const DUPLICATE_TEXT_MARKUP_EDITOR_SELECTOR = [
    '.highlightEditor:not([class*="pdf-markup-subtype"])',
    '[role="mark"]:not([class*="pdf-markup-subtype"])',
].join(', ');

function hasTextMarkupEditorLayerVisualContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return queryPdfLayerVisualSnapshotElements(layer, TEXT_MARKUP_EDITOR_SELECTOR)
        .some(isPdfLayerVisualElementVisiblyPainted);
}

export function preservePdfPageAnnotationVisualSnapshot(
    pageContainer: HTMLElement | null | undefined,
    annotationEditorLayer: HTMLElement | null | undefined,
) {
    if (
        !pageContainer
        || typeof pageContainer.querySelector !== 'function'
        || pageContainer.querySelector(`.${pdfLayerVisualSnapshotClass}`)
    ) {
        return null;
    }

    const canvasHost = getPdfLayerVisualSnapshotCanvasHost(pageContainer);
    const editorLayer = annotationEditorLayer ?? getPdfLayerVisualSnapshotAnnotationEditorLayer(pageContainer);
    const hasDrawLayerVisuals = hasPdfDrawLayerVisualContent(canvasHost);
    const hasTextMarkupEditors = hasTextMarkupEditorLayerVisualContent(editorLayer);
    const annotationLayerExcludeSelectors = hasDrawLayerVisuals || hasTextMarkupEditors
        ? ['.editorAnnotation']
        : [];
    const editorLayerExcludeSelectors = hasDrawLayerVisuals
        ? [DUPLICATE_TEXT_MARKUP_EDITOR_SELECTOR]
        : [];
    return combinePdfLayerVisualSnapshotReleases([
        preservePdfLayerVisualSnapshot(getPdfLayerVisualSnapshotAnnotationLayer(pageContainer), {
            excludeSelectors: annotationLayerExcludeSelectors,
            suppressLiveContentWhenEmpty: annotationLayerExcludeSelectors.length > 0,
        }),
        preservePdfDrawLayerVisualSnapshot(canvasHost),
        preservePdfLayerVisualSnapshot(editorLayer, {
            excludeSelectors: editorLayerExcludeSelectors,
            suppressLiveContentWhenEmpty: hasDrawLayerVisuals || editorLayerExcludeSelectors.length > 0,
        }),
    ]);
}
