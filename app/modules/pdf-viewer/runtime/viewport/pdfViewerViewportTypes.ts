import type { TZoomInteractionLockOperationId } from '@app/modules/pdf-viewer/runtime/zoom/pdfViewerZoomTypes';

export interface IResizeTransitionSignal {
    active: boolean;
    source: string;
    token: number;
    anchorPage: number | null;
}

export interface IZoomViewportAnchor {
    id?: number;
    sessionId?: number;
    zoomLockOperationId?: TZoomInteractionLockOperationId | null;
    x: number;
    y: number;
    capturedAtMs: number;
}
