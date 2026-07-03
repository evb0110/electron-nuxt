import type { IPdfViewerTransactionRenderRequest } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';

export interface IRenderVisiblePagesOptions {
    preserveRenderedPages?: boolean;
    bufferOverride?: number;
    renderWindowOverride?: {
        start: number;
        end: number;
    };
    forceRerender?: boolean;
    maxCanvasPixelsOverride?: number;
    markRenderedPageStale?: boolean;
    preserveInFlightRequiredPages?: boolean;
    prioritizeTextLayer?: boolean;
    transactionRequest?: IPdfViewerTransactionRenderRequest;
}
