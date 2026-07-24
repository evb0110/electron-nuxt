import type { IPdfViewerTransactionRenderRequest } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { TPdfRenderContinuationPriority } from '@app/modules/pdf-viewer/engine/pdf-render-continuation-scheduler/pdfRenderContinuationScheduler';
import type {
    RenderTask,
    PDFPageProxy,
} from 'pdfjs-dist';

export type TPdfPageRenderContentIntent =
    | 'full-visible'
    | 'canvas-only-buffer'
    | 'canvas-only-refine'
    | 'layers-only-promotion';

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
    contentIntent?: TPdfPageRenderContentIntent;
    maxCanvasPixels?: number;
    preserveCommittedVisual?: boolean;
    coordinatorDemand?: {
        kind: 'required' | 'buffer' | 'prewarm';
        renderGeneration: number;
    };
    rasterSchedulerTaskBridge?: {bind(task: RenderTask): void;};
    rasterSchedulerPage?: PDFPageProxy;
    rasterDemandPages?: readonly number[];
    bufferMaxCanvasPixels?: number;
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
