export interface IResizeTransitionSignal {
    active: boolean;
    source: string;
    token: number;
    anchorPage: number | null;
}

export interface IZoomViewportAnchor {
    id?: number;
    sessionId?: number;
    x: number;
    y: number;
    capturedAtMs: number;
}
