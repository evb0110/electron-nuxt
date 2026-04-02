import type { IShapeAnnotation } from '@app/types/annotations';
import { normalizePdfJsAnnotationId } from '@app/composables/pdf/pdfSerializationRefs';

interface IPageRange {
    start: number;
    end: number;
}

interface IRenderVisiblePagesOptions {
    preserveRenderedPages?: boolean;
    forceRerender?: boolean;
    bufferOverride?: number;
}

interface IRefreshDeletedEmbeddedShapePageOptions {
    shape: Pick<IShapeAnnotation, 'annotationId' | 'pageIndex' | 'source'> | null;
    viewerContainer: HTMLElement | null;
    syncHiddenEmbeddedAnnotationDom: () => void;
}

interface IRerenderRenderedManagedEmbeddedShapePagesOptions {
    shapes: Array<Pick<IShapeAnnotation, 'annotationId' | 'pageIndex' | 'source'>>;
    isPageRendered: (pageNumber: number) => boolean;
    renderVisiblePages: (
        visibleRange: IPageRange,
        renderOptions?: IRenderVisiblePagesOptions,
    ) => Promise<void>;
}

export function removeEmbeddedShapeAnnotationDom(
    viewerContainer: HTMLElement | null,
    annotationId: string | null | undefined,
) {
    const normalizedAnnotationId = normalizePdfJsAnnotationId(annotationId);
    if (!viewerContainer || !normalizedAnnotationId) {
        return;
    }

    viewerContainer.querySelectorAll<HTMLElement>('[data-annotation-id]').forEach((element) => {
        if (normalizePdfJsAnnotationId(element.dataset.annotationId) === normalizedAnnotationId) {
            element.remove();
        }
    });

    viewerContainer.querySelectorAll<HTMLElement>(
        '.annotationLayer .popup[data-annotation-id], .annotation-layer .popup[data-annotation-id]',
    ).forEach((popup) => {
        const parentAnnotationId = normalizePdfJsAnnotationId(
            popup.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId,
        );
        if (parentAnnotationId === normalizedAnnotationId) {
            popup.remove();
        }
    });
}

// Imported PDF drawings remain part of the PDF.js render tree until the page
// is repainted, but once a page has been repainted with our hidden-id filter
// applied, later deletes can stay local to the overlay/annotation DOM.
export function refreshDeletedEmbeddedShapePage({
    shape,
    viewerContainer,
    syncHiddenEmbeddedAnnotationDom,
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
}

export function rerenderRenderedManagedEmbeddedShapePages({
    shapes,
    isPageRendered,
    renderVisiblePages,
}: IRerenderRenderedManagedEmbeddedShapePagesOptions) {
    const renderedManagedPages = Array.from(new Set(
        shapes
            .filter(shape => shape.source === 'embedded' && !!shape.annotationId)
            .map(shape => Math.max(1, Math.floor(shape.pageIndex) + 1))
            .filter(pageNumber => isPageRendered(pageNumber)),
    )).sort((left, right) => left - right);

    if (renderedManagedPages.length === 0) {
        return;
    }

    void renderVisiblePages(
        {
            start: renderedManagedPages[0]!,
            end: renderedManagedPages[renderedManagedPages.length - 1]!,
        },
        {
            preserveRenderedPages: true,
            forceRerender: true,
            bufferOverride: 0,
        },
    );
}
