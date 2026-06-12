import type { IClientRect } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';

export interface ICanvasSource {
    canvas: HTMLCanvasElement;
    rect: IClientRect;
}

export interface ICaptureFragment {
    canvas: HTMLCanvasElement;
    intersection: IClientRect;
    sourceX: number;
    sourceY: number;
    sourceWidth: number;
    sourceHeight: number;
    scaleX: number;
    scaleY: number;
}

export interface ICapturePlan {
    outputRect: IClientRect | null;
    fragments: ICaptureFragment[];
}
