import type { IPageRange } from '@app/types/pdfUi';
import {
    resolveDocumentRasterResidencyPlan,
    type IDocumentRasterResidencyPlan,
} from '@app/utils/document-viewer/rendering/resolveDocumentRasterResidencyPlan';

export interface IPdfRasterResidencyPlanOptions {
    mountedPages: readonly number[];
    visibleRange: IPageRange;
    bufferRadius: number;
    maxBufferPixels: number;
    estimatePagePixels: (pageNumber: number) => number;
}

export interface IPdfRasterResidencyPlan extends Omit<IDocumentRasterResidencyPlan, 'maxPixelsPerBufferSurface'> {maxPixelsPerBufferCanvas: number;}

/** PDF visibility adapter for the shared document raster admission policy. */
export function resolvePdfRasterResidencyPlan(
    options: IPdfRasterResidencyPlanOptions,
): IPdfRasterResidencyPlan {
    const start = Math.max(1, Math.trunc(options.visibleRange.start));
    const end = Math.max(start, Math.trunc(options.visibleRange.end));
    const plan = resolveDocumentRasterResidencyPlan({
        mountedPages: options.mountedPages,
        visiblePages: Array.from({length: end - start + 1}, (_, index) => start + index),
        bufferRadius: options.bufferRadius,
        maxBufferPixels: options.maxBufferPixels,
        estimatePagePixels: options.estimatePagePixels,
    });
    const {
        maxPixelsPerBufferSurface,
        ...residency
    } = plan;
    return {
        ...residency,
        maxPixelsPerBufferCanvas: maxPixelsPerBufferSurface,
    };
}
