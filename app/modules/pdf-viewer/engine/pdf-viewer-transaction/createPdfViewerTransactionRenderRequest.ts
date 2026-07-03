import type { IPageRange } from '@app/types/pdfUi';
import type {
    IPdfViewerTransaction,
    IPdfViewerTransactionRenderRequest,
    TPdfViewerTransactionPriority,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import { createDocumentViewportRenderRequest } from '@app/utils/document-viewer/viewport/createDocumentViewportRenderRequest';

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
    return {
        ...createDocumentViewportRenderRequest({
            transaction: options.transaction,
            renderRequestId: options.renderRequestId,
            renderVersion: options.renderVersion,
            range: options.range,
            requiredRange: options.requiredRange,
            buffer: options.buffer,
            preserveRenderedPages: options.preserveRenderedPages,
            preserveInFlightRequiredPages: options.preserveInFlightRequiredPages,
            forceRerender: options.forceRerender,
            priority: options.priority ?? 'authoritative',
        }),
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
