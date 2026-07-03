import type { IPageRange } from '@app/types/pdfUi';
import type {
    IPdfViewerTransaction,
    IPdfViewerTransactionRenderRequest,
    TPdfViewerTransactionPriority,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';

export interface ICreatePdfViewerTransactionRenderRequestOptions {
    transaction: IPdfViewerTransaction;
    renderRequestId: number;
    renderVersion: number;
    range?: IPageRange | undefined;
    requiredRange?: IPageRange | undefined;
    buffer?: number | undefined;
    preserveRenderedPages?: boolean | undefined;
    preserveInFlightRequiredPages?: boolean | undefined;
    forceRerender?: boolean | undefined;
    renderWindowOverride?: IPageRange | undefined;
    maxCanvasPixelsOverride?: number | undefined;
    prioritizeTextLayer?: boolean | undefined;
    priority?: TPdfViewerTransactionPriority | undefined;
}

export function createPdfViewerTransactionRenderRequest(
    options: ICreatePdfViewerTransactionRenderRequestOptions,
): IPdfViewerTransactionRenderRequest {
    const range = options.range ?? options.transaction.target?.range ?? {
        start: options.transaction.target?.page ?? 1,
        end: options.transaction.target?.page ?? 1,
    };
    return {
        transactionId: options.transaction.id,
        renderRequestId: options.renderRequestId,
        documentVersion: options.transaction.documentRef.documentVersion,
        renderVersion: options.renderVersion,
        source: options.transaction.source,
        range,
        requiredRange: options.requiredRange ?? range,
        buffer: options.buffer ?? 0,
        preserveRenderedPages: options.preserveRenderedPages ?? false,
        preserveInFlightRequiredPages: options.preserveInFlightRequiredPages ?? false,
        forceRerender: options.forceRerender ?? false,
        ...(options.renderWindowOverride ? { renderWindowOverride: options.renderWindowOverride } : {}),
        ...(options.maxCanvasPixelsOverride !== undefined
            ? { maxCanvasPixelsOverride: options.maxCanvasPixelsOverride }
            : {}),
        ...(options.prioritizeTextLayer !== undefined
            ? { prioritizeTextLayer: options.prioritizeTextLayer }
            : {}),
        priority: options.priority ?? 'authoritative',
    };
}
