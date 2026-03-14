export interface IPdfImagePlacementDraft {
    pageNumber: number;
    x: number;
    y: number;
    width: number;
    height: number;
    previewUrl: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    intrinsicWidth: number;
    intrinsicHeight: number;
}

export interface IPdfImagePlacementRectUpdate {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IPdfPlacedImageFinalizePayload {
    pageNumber: number;
    x: number;
    y: number;
    width: number;
    height: number;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    targetPixelWidth: number;
    targetPixelHeight: number;
}
