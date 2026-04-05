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
    rerenderEmbeddedShapePage?: (pageNumber: number) => void;
}

interface IShouldRefreshManagedShapePageOptions {
    pageNumber: number;
    visibleRange: IPageRange;
    renderBuffer: number;
    isPageRendered: (pageNumber: number) => boolean;
    hasRenderedCanvasDom?: (pageNumber: number) => boolean;
}

interface IRerenderRenderedManagedEmbeddedShapePagesOptions {
    shapes: Array<Pick<IShapeAnnotation, 'annotationId' | 'pageIndex' | 'source'>>;
    visibleRange: IPageRange;
    renderBuffer: number;
    isPageRendered: (pageNumber: number) => boolean;
    invalidatePages: (pages: number[]) => void;
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

export function shouldRefreshManagedShapePage({
    pageNumber,
    visibleRange,
    renderBuffer,
    isPageRendered,
    hasRenderedCanvasDom,
}: IShouldRefreshManagedShapePageOptions) {
    const normalizedPageNumber = Math.max(1, Math.floor(pageNumber));
    const normalizedBuffer = Math.max(0, Math.floor(renderBuffer));
    const renderWindowStart = Math.max(1, Math.floor(visibleRange.start) - normalizedBuffer);
    const renderWindowEnd = Math.max(
        renderWindowStart,
        Math.floor(visibleRange.end) + normalizedBuffer,
    );

    return (
        isPageRendered(normalizedPageNumber)
        || hasRenderedCanvasDom?.(normalizedPageNumber) === true
        || (
            normalizedPageNumber >= renderWindowStart
            && normalizedPageNumber <= renderWindowEnd
        )
    );
}

export async function rerenderRenderedManagedEmbeddedShapePages({
    shapes,
    visibleRange,
    renderBuffer,
    isPageRendered,
    invalidatePages,
    renderVisiblePages,
}: IRerenderRenderedManagedEmbeddedShapePagesOptions) {
    const renderedManagedPages = Array.from(new Set(
        shapes
            .filter(shape => shape.source === 'embedded' && !!shape.annotationId)
            .map(shape => Math.max(1, Math.floor(shape.pageIndex) + 1))
            .filter(pageNumber => shouldRefreshManagedShapePage({
                pageNumber,
                visibleRange,
                renderBuffer,
                isPageRendered,
            })),
    )).sort((left, right) => left - right);

    if (renderedManagedPages.length === 0) {
        return;
    }

    invalidatePages(renderedManagedPages);

    await renderVisiblePages(
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
