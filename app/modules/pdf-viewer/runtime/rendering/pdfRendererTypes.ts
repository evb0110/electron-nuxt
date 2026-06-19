export interface ICancelableRenderTask {
    cancel: () => void;
    promise: Promise<unknown>;
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

export type TPdfTextLayerCleanup = () => void;

export type TClearSelectionBeforePageLayerTeardown = (pageNumber: number) => boolean;

export interface IRenderVisiblePagesOptions {
    preserveRenderedPages?: boolean;
    bufferOverride?: number;
    forceRerender?: boolean;
    maxCanvasPixelsOverride?: number;
    markRenderedPageStale?: boolean;
    preserveInFlightRequiredPages?: boolean;
    prioritizeTextLayer?: boolean;
}
