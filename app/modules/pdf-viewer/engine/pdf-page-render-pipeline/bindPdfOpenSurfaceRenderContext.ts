import type { IPdfViewerTransactionRenderRequest } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { TPdfRenderContinuationPriority } from '@app/modules/pdf-viewer/engine/pdf-render-continuation-scheduler/pdfRenderContinuationScheduler';

export interface IRenderVisiblePagesOptions {
    openSurfaceGeneration?: number;
    openSurfaceRevision?: string;
    preserveRenderedPages?: boolean;
    bufferOverride?: number;
    renderWindowOverride?: {
        start: number;
        end: number;
    };
    forceRerender?: boolean;
    preserveInFlightRequiredPages?: boolean;
    prioritizeTextLayer?: boolean;
    transactionRequest?: IPdfViewerTransactionRenderRequest;
    continuationPriority?: TPdfRenderContinuationPriority;
    maxCanvasPixels?: number;
    coordinatorDemand?: {
        kind: 'required' | 'buffer';
        renderGeneration: number;
    };
}

export type TPdfOpenSurfaceRenderContext = Pick<
    Required<IRenderVisiblePagesOptions>,
    'openSurfaceGeneration' | 'openSurfaceRevision'
>;

export function bindPdfOpenSurfaceRenderContext(
    renderOptions: IRenderVisiblePagesOptions | undefined,
    context: TPdfOpenSurfaceRenderContext | undefined,
) {
    return context
        ? {
            ...renderOptions,
            ...context,
        }
        : renderOptions;
}
