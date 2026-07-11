import type {IManagedTempFileHandle} from '@contracts/electronApiDocuments';

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
    nativeSourceHandle?: IManagedTempFileHandle;
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
    nativeSourceHandle?: IManagedTempFileHandle;
    targetPixelWidth: number;
    targetPixelHeight: number;
}
