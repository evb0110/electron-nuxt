export type TPageRenderStallStage = 'page-load' | 'canvas-render' | 'text-layer';

export interface IPageRenderStallPayload {
    pageNumber: number;
    stage: TPageRenderStallStage;
    timeoutMs: number;
}

export interface IPageRenderTimeoutError extends Error {
    pageNumber: number;
    stage: TPageRenderStallStage;
    timeoutMs: number;
}
