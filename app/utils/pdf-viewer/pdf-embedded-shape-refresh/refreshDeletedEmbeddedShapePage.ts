import type { IShapeAnnotation } from '@app/types/annotations';
import { removeEmbeddedShapeAnnotationDom } from '@app/utils/pdf-viewer/pdf-embedded-shape-refresh/removeEmbeddedShapeAnnotationDom';

interface IRefreshDeletedEmbeddedShapePageOptions {
    shape: Pick<IShapeAnnotation, 'annotationId' | 'pageIndex' | 'source'> | null;
    viewerContainer: HTMLElement | null;
    syncHiddenEmbeddedAnnotationDom: () => void;
    rerenderEmbeddedShapePage?: (pageNumber: number) => void;
}

// Imported PDF drawings remain part of the PDF.js render tree until the page
// is repainted. Most pages are already corrected by the import-time rerender,
// but deletes still force a targeted repaint of the affected page so any stale
// appearance paint is cleared immediately.
export function refreshDeletedEmbeddedShapePage({
    shape,
    viewerContainer,
    syncHiddenEmbeddedAnnotationDom,
    rerenderEmbeddedShapePage,
}: IRefreshDeletedEmbeddedShapePageOptions) {
    syncHiddenEmbeddedAnnotationDom();

    if (
        !shape
        || shape.source !== 'embedded'
        || !shape.annotationId
        || !Number.isFinite(shape.pageIndex)
    ) {
        return;
    }

    removeEmbeddedShapeAnnotationDom(viewerContainer, shape.annotationId);
    rerenderEmbeddedShapePage?.(Math.max(1, Math.floor(shape.pageIndex) + 1));
}
