import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { IPageRange } from '@app/types/pdfUi';



interface IShouldRefreshManagedShapePageOptions {
    pageNumber: TPageNumber;
    visibleRange: IPageRange;
    renderBuffer: number;
    isPageRendered: (pageNumber: TPageNumber) => boolean;
    hasRenderedCanvasDom?: (pageNumber: TPageNumber) => boolean;
}

export function shouldRefreshManagedShapePage({
    pageNumber,
    visibleRange,
    renderBuffer,
    isPageRendered,
    hasRenderedCanvasDom,
}: IShouldRefreshManagedShapePageOptions) {
    const normalizedPageNumber = requirePageNumber(Math.max(1, Math.floor(pageNumber)));
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
