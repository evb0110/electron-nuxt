export interface IPdfImagePlacementDraft {
    pageNumber: number;
    x: number;
    y: number;
    width: number;
    height: number;
    rotationDegrees: number;
    previewUrl: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
}

export interface IPdfImagePlacementRectUpdate {
    x: number;
    y: number;
    width: number;
    height: number;
    rotationDegrees?: number;
}

export interface IPdfPlacedImageFinalizePayload {
    pageNumber: number;
    x: number;
    y: number;
    width: number;
    height: number;
    rotationDegrees: number;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    targetPixelWidth: number;
    targetPixelHeight: number;
}
