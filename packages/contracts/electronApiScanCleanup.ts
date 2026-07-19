export type TScanCleanupLayoutMode = 'auto' | 'force-single' | 'force-two-page';
export type TScanCleanupOutputMode = 'bw' | 'grayscale';
export type TScanCleanupPageAlignment =
    | 'top-left' | 'top-center' | 'top-right'
    | 'center-left' | 'center' | 'center-right'
    | 'bottom-left' | 'bottom-center' | 'bottom-right';
export type TScanCleanupPhase = 'queued' | 'normalizing' | 'rasterizing' | 'cleaning' | 'assembling' | 'handoff';
export type TScanCleanupErrorCode = 'invalid-request' | 'tools-unavailable' | 'sidecar-failed' | 'canceled' | 'internal';

export interface IScanCleanupOptions {
    layoutMode: TScanCleanupLayoutMode;
    outputMode: TScanCleanupOutputMode;
    thickness: number;
    crop: boolean;
    matchPageSize: boolean;
    pageAlignment: TScanCleanupPageAlignment;
    marginsMm: number;
    despeckle: boolean;
}

export interface IScanCleanupPreviewRequest {
    sourcePdfPath: string;
    pageNumber: number;
    options: IScanCleanupOptions;
}

export interface IScanCleanupPreviewRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IScanCleanupPreviewAffine {matrix: number[][];}

export interface IScanCleanupPreviewMetadata {
    half: 'full' | 'left' | 'right';
    layoutClassification: 'single-uncut-page' | 'page-with-offcut' | 'two-page-spread';
    sourceRegion: IScanCleanupPreviewRect;
    contentBox: IScanCleanupPreviewRect | null;
    appliedMargins: [number, number, number, number];
    outputWidth: number;
    outputHeight: number;
    forwardTransform: IScanCleanupPreviewAffine | null;
    warnings: string[];
}

export interface IScanCleanupPreviewOutput {
    imageData: Uint8Array;
    metadata: IScanCleanupPreviewMetadata;
}

export interface IScanCleanupPreviewResult {
    pageNumber: number;
    totalPages: number;
    rawImageData: Uint8Array;
    rawWidth: number;
    rawHeight: number;
    outputs: IScanCleanupPreviewOutput[];
}

export interface IScanCleanupStartRequest {
    sourcePdfPath: string;
    /** @deprecated Ignored. Generated output paths are always managed by the main process. */
    outputPdfPath?: string;
    options: IScanCleanupOptions;
}

export interface IScanCleanupSummary {
    inputPages: number;
    outputPages: number;
    spreadsSplit: number;
    offcutsDiscarded: number;
    deskewSkipped: number;
    cropSkipped: number;
    warnings: string[];
}

export interface IScanCleanupProgress {
    phase: TScanCleanupPhase;
    processedCount: number;
    totalPages: number;
    percent: number;
}

interface IScanCleanupJobBase {
    jobId: string;
    progress: IScanCleanupProgress;
    updatedAtMs: number;
}

export type TScanCleanupJobState =
    | IScanCleanupJobBase & {status: 'queued' | 'running' | 'handoff'}
    | IScanCleanupJobBase & {
        status: 'completed';
        outputPdfPath: string;
        summary: IScanCleanupSummary
    }
    | IScanCleanupJobBase & {status: 'canceled'}
    | IScanCleanupJobBase & {
        status: 'failed';
        error: string;
        errorCode: TScanCleanupErrorCode
    };

export interface IScanCleanupStartResult {
    started: boolean;
    jobId: string;
    outputPdfPath?: string;
    error?: string;
    errorCode?: TScanCleanupErrorCode;
}

export interface IScanCleanupCapability {
    preview: (request: IScanCleanupPreviewRequest) => Promise<IScanCleanupPreviewResult>;
    cancelPreview: (sourcePdfPath: string) => Promise<boolean>;
    start: (request: IScanCleanupStartRequest) => Promise<IScanCleanupStartResult>;
    cancel: (jobId: string) => Promise<boolean>;
    getJobState: (jobId: string) => Promise<TScanCleanupJobState | null>;
    subscribeJob: (jobId: string) => Promise<TScanCleanupJobState | null>;
    reconnectJob: (jobId: string) => Promise<TScanCleanupJobState | null>;
    pruneGeneratedOutputs: (openPdfPaths: string[]) => Promise<number>;
    onJobState: (callback: (state: TScanCleanupJobState) => void) => () => void;
}
