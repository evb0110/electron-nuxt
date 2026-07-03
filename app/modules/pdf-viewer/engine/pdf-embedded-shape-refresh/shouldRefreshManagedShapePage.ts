import type { IPageRange } from '@app/types/pdfUi';



interface IShouldRefreshManagedShapePageOptions {
    pageNumber: number;
    visibleRange: IPageRange;
    renderBuffer: number;
    isPageRendered: (pageNumber: number) => boolean;
    hasRenderedCanvasDom?: (pageNumber: number) => boolean;
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
