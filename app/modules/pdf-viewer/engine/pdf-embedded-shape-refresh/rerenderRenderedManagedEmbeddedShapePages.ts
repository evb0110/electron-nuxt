import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import type { IPageRange } from '@app/types/pdfUi';
import { uniq } from 'es-toolkit/array';
import type { IShapeAnnotation } from '@app/types/annotations';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { shouldRefreshManagedShapePage } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/shouldRefreshManagedShapePage';



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

export async function rerenderRenderedManagedEmbeddedShapePages({
    shapes,
    visibleRange,
    renderBuffer,
    isPageRendered,
    invalidatePages,
    renderVisiblePages,
}: IRerenderRenderedManagedEmbeddedShapePagesOptions) {
    const renderedManagedPages = uniq(
        shapes
            .filter(shape => shape.source === 'embedded' && !!shape.annotationId)
            .map(shape => Math.max(1, Math.floor(shape.pageIndex) + 1))
            .filter(pageNumber => shouldRefreshManagedShapePage({
                pageNumber,
                visibleRange,
                renderBuffer,
                isPageRendered,
            })),
    ).sort((left, right) => left - right);

    if (renderedManagedPages.length === 0) {
        logPdfRenderTrace('embedded-shape-rerender-skip', {
            shapeCount: shapes.length,
            visibleRange,
            renderBuffer,
        });
        return;
    }

    logPdfRenderTrace('embedded-shape-rerender-invalidate', {
        renderedManagedPages,
        shapeCount: shapes.length,
        visibleRange,
        renderBuffer,
    });
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
