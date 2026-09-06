import { hasPdfDrawLayerVisualContent } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/hasPdfDrawLayerVisualContent';
import { getPdfLayerVisualSnapshotCanvasHost } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotDom';

export function hasPdfPageDrawLayerVisualContent(
    pageContainer: HTMLElement | null | undefined,
) {
    return hasPdfDrawLayerVisualContent(getPdfLayerVisualSnapshotCanvasHost(pageContainer));
}
