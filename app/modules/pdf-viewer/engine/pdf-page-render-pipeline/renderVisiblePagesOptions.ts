import type { IPdfViewerTransactionRenderRequest } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { TPdfRenderContinuationPriority } from '@app/modules/pdf-viewer/engine/pdf-render-continuation-scheduler/pdfRenderContinuationScheduler';

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
    continuationPriority?: TPdfRenderContinuationPriority;
}
