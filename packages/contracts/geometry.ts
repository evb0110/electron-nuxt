export interface IPoint2D {
    x: number;
    y: number;
}

export interface IMarkerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface IPdfBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IPageGeometry {
    mediaBox: IPdfBox;
    cropBox: IPdfBox | null;
    rotation: number;
}
