import type { IClientRect } from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';

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
