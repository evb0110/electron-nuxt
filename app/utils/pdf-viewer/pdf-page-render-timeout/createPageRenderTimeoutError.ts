import type {
    IPageRenderTimeoutError,
    TPageRenderStallStage,
} from '@app/utils/pdf-viewer/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';

export function createPageRenderTimeoutError(
    pageNumber: number,
    stage: TPageRenderStallStage,
    timeoutMs: number,
): IPageRenderTimeoutError {
    const error = new Error(
        `Timed out waiting for ${stage} on page ${pageNumber} after ${timeoutMs}ms`,
    ) as IPageRenderTimeoutError;
    error.name = 'PdfPageRenderTimeoutError';
    error.pageNumber = pageNumber;
    error.stage = stage;
    error.timeoutMs = timeoutMs;
    return error;
}
