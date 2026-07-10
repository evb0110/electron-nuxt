export type TPageRenderStallStage =
    | 'page-load'
    | 'canvas-prepare'
    | 'canvas-render'
    | 'text-layer'
    | 'annotation-layer'
    | 'annotation-editor-layer';

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
