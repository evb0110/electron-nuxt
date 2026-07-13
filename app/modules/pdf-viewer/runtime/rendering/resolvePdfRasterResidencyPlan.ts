import type { IPageRange } from '@app/types/pdfUi';

export interface IPdfRasterResidencyPlanOptions {
    mountedPages: readonly number[];
    visibleRange: IPageRange;
    bufferRadius: number;
    maxBufferPixels: number;
    estimatePagePixels: (pageNumber: number) => number;
}

export interface IPdfRasterResidencyPlan {
    visiblePages: number[];
    bufferPages: number[];
    residentPages: number[];
    maxPixelsPerBufferCanvas: number;
    estimatedBufferPixels: number;
}

function normalizePixels(value: number) {
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.ceil(value)) : 1;
}

function getDistanceFromVisibleRange(pageNumber: number, visibleRange: IPageRange) {
    if (pageNumber < visibleRange.start) {
        return visibleRange.start - pageNumber;
    }
    if (pageNumber > visibleRange.end) {
        return pageNumber - visibleRange.end;
    }
    return 0;
}

/**
 * Keeps DOM virtualization independent from raster residency. Visible pages
 * are always resident. Non-visible pages share one aggregate pixel budget and
 * are admitted nearest-first, so render history can never leave a farther page
 * rasterized while an affordable nearer page is absent.
 */
export function resolvePdfRasterResidencyPlan(
    options: IPdfRasterResidencyPlanOptions,
): IPdfRasterResidencyPlan {
    const mountedPages = [...new Set(options.mountedPages)]
        .filter(pageNumber => Number.isInteger(pageNumber) && pageNumber > 0);
    const visiblePages = mountedPages
        .filter(pageNumber => (
            pageNumber >= options.visibleRange.start
            && pageNumber <= options.visibleRange.end
        ))
        .sort((left, right) => left - right);
    const bufferRadius = Math.max(0, Math.trunc(options.bufferRadius));
    const candidates = mountedPages
        .filter((pageNumber) => {
            const distance = getDistanceFromVisibleRange(pageNumber, options.visibleRange);
            return distance > 0 && distance <= bufferRadius;
        })
        .sort((left, right) => (
            getDistanceFromVisibleRange(left, options.visibleRange)
            - getDistanceFromVisibleRange(right, options.visibleRange)
            // At equal distance, warm the forward page first. Both immediate
            // neighbors receive equal grants whenever both are mounted.
            || right - left
        ));
    const maxBufferPixels = Math.max(0, Math.trunc(options.maxBufferPixels));
    const guaranteedNeighborCount = Math.min(2, candidates.length);
    const maxPixelsPerBufferCanvas = guaranteedNeighborCount > 0
        ? Math.max(1, Math.floor(maxBufferPixels / guaranteedNeighborCount))
        : 0;
    const bufferPages: number[] = [];
    let estimatedBufferPixels = 0;

    for (const pageNumber of candidates) {
        const estimatedPixels = Math.min(
            normalizePixels(options.estimatePagePixels(pageNumber)),
            maxPixelsPerBufferCanvas,
        );
        if (estimatedBufferPixels + estimatedPixels > maxBufferPixels) {
            break;
        }
        bufferPages.push(pageNumber);
        estimatedBufferPixels += estimatedPixels;
    }

    return {
        visiblePages,
        bufferPages,
        residentPages: [
            ...visiblePages,
            ...bufferPages,
        ],
        maxPixelsPerBufferCanvas,
        estimatedBufferPixels,
    };
}
