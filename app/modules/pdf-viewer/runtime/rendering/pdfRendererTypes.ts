import type {
    PDFPageProxy,
    RenderTask,
} from 'pdfjs-dist';
export type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';

export interface ICancelableRenderTask {
    cancel: () => void;
    promise: Promise<unknown>;
    onContinue?: RenderTask['onContinue'];
}

export interface IActivePdfRenderTask {
    version: number;
    requestId: number;
    task: ICancelableRenderTask;
}

export interface IActivePdfTextLayerTask {
    version: number;
    requestId: number;
    controller: AbortController;
}

export interface IPdfCanvasDomCommit {
    openSurfaceGeneration: number;
    documentRevision: string;
    renderVersion: number;
    requestId: number;
    pageNumber: number;
}

export interface IPdfLayerRenderResult {
    canvas: HTMLCanvasElement;
    viewport: ReturnType<PDFPageProxy['getViewport']>;
    annotationCanvasMap: Map<string, HTMLCanvasElement> | null;
    scaleX: number;
    scaleY: number;
    rawDims: {
        pageWidth: number;
        pageHeight: number;
    };
    userUnit: number;
    totalScaleFactor: number;
}

export interface IPdfPageLayerRenderContext {
    container: HTMLElement;
    pdfPage: PDFPageProxy;
    renderResult: IPdfLayerRenderResult;
    textLayerDiv: HTMLDivElement | null;
    annotationLayerInstance: unknown;
    preserveCanvasOnStale?: boolean;
}

export type TPdfTextLayerCleanup = () => void;

export type TClearSelectionBeforePageLayerTeardown = (pageNumber: number) => boolean;
