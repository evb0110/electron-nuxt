export interface ICancelableRenderTask {
    cancel: () => void;
    promise: Promise<unknown>;
}

export interface IRenderVisiblePagesOptions {
    preserveRenderedPages?: boolean;
    bufferOverride?: number;
    forceRerender?: boolean;
    maxCanvasPixelsOverride?: number;
    markRenderedPageStale?: boolean;
    preserveInFlightRequiredPages?: boolean;
    prioritizeTextLayer?: boolean;
}
