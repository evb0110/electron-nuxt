import type {
    IPdfPageMetric,
    TFitMode,
    TPdfViewMode,
} from '@app/types/pdf';
import { getCurrentSpreadRenderedBoundsFromDom } from '@app/utils/pdf-viewer/pdf-horizontal-scroll-clamp/getCurrentSpreadRenderedBoundsFromDom';
import { getCurrentSpreadRenderedBoundsFromMetrics } from '@app/utils/pdf-viewer/pdf-horizontal-scroll-clamp/getCurrentSpreadRenderedBoundsFromMetrics';
import { resolvePageBoundedHorizontalScroll } from '@app/utils/pdf-viewer/pdf-horizontal-scroll-clamp/resolvePageBoundedHorizontalScroll';

export function resolveHorizontalScrollClampForActiveSpread(options: {
    container: HTMLElement | null;
    fitMode: TFitMode;
    pageNumber: number;
    viewMode: TPdfViewMode;
    numPages: number;
    basePageWidth: number | null;
    basePageHeight: number | null;
    pageMetrics: IPdfPageMetric[];
    effectiveScale: number;
    scaledMargin: number;
    epsilon: number;
}) {
    if (!options.container || options.fitMode !== 'width') {
        return null;
    }

    const renderedSpreadBounds =
        getCurrentSpreadRenderedBoundsFromDom({
            container: options.container,
            pageNumber: options.pageNumber,
            viewMode: options.viewMode,
            totalPages: options.numPages,
        })
        ?? getCurrentSpreadRenderedBoundsFromMetrics({
            container: options.container,
            basePageWidth: options.basePageWidth,
            basePageHeight: options.basePageHeight,
            numPages: options.numPages,
            pageMetrics: options.pageMetrics,
            currentPage: options.pageNumber,
            viewMode: options.viewMode,
            effectiveScale: options.effectiveScale,
            scaledMargin: options.scaledMargin,
        });
    if (!renderedSpreadBounds) {
        return null;
    }

    return resolvePageBoundedHorizontalScroll({
        scrollLeft: options.container.scrollLeft,
        viewportWidth: options.container.clientWidth,
        pageLeft: renderedSpreadBounds.left,
        pageWidth: renderedSpreadBounds.width,
        margin: options.scaledMargin,
        epsilon: options.epsilon,
    });
}
