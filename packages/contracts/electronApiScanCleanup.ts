export type TScanCleanupLayoutMode = 'auto' | 'force-single' | 'force-two-page';
export type TScanCleanupOutputMode = 'bw' | 'grayscale' | 'color';
export type TScanCleanupReadingOrder = 'ltr' | 'rtl';
export type TScanCleanupPageRotation = 0 | 90 | 180 | 270;
export type TScanCleanupPageLayoutOverride = 'auto' | 'single' | 'spread' | 'keep-left' | 'keep-right';
export type TScanCleanupPageAlignment =
    | 'top-left' | 'top-center' | 'top-right'
    | 'center-left' | 'center' | 'center-right'
    | 'bottom-left' | 'bottom-center' | 'bottom-right';
export type TScanCleanupOutputHalf = 'full' | 'left' | 'right';
export type TScanCleanupPhase = 'queued' | 'normalizing' | 'rasterizing' | 'cleaning' | 'assembling' | 'handoff';
export type TScanCleanupErrorCode = 'invalid-request' | 'tools-unavailable' | 'sidecar-failed' | 'canceled' | 'internal';

export interface IScanCleanupPageOverride {
    rotation: TScanCleanupPageRotation;
    layoutOverride: TScanCleanupPageLayoutOverride;
    excluded: boolean;
    manualSplitX: number | null;
    manualContentBoxes?: Partial<Record<TScanCleanupOutputHalf, IScanCleanupPreviewRect>>;
    placementOverrides?: Partial<Record<TScanCleanupOutputHalf, TScanCleanupPageAlignment>>;
}

export type TScanCleanupPageOverrides = Record<string, IScanCleanupPageOverride>;

export interface IScanCleanupOptions {
    preserveOriginalQuality?: boolean;
    layoutMode: TScanCleanupLayoutMode;
    outputMode: TScanCleanupOutputMode;
    thickness: number;
    crop: boolean;
    matchPageSize: boolean;
    pageAlignment: TScanCleanupPageAlignment;
    marginsMm: number;
    despeckle: boolean;
    readingOrder: TScanCleanupReadingOrder;
    skipBlankPages: boolean;
    straightenCurvedLines: boolean;
    pageOverrides: TScanCleanupPageOverrides;
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
    layoutConfidence: number;
    sourceRegion: IScanCleanupPreviewRect;
    contentBox: IScanCleanupPreviewRect | null;
    appliedMargins: [number, number, number, number];
    outputWidth: number;
    outputHeight: number;
    forwardTransform: IScanCleanupPreviewAffine | null;
    cutterX: number | null;
    inputWidth: number;
    inputHeight: number;
    rotation: TScanCleanupPageRotation;
    resamplePasses: number;
    warnings: string[];
}

export interface IScanCleanupPreviewPageMetadata {
    layoutClassification: IScanCleanupPreviewMetadata['layoutClassification'];
    cutterX: number | null;
    rotation: TScanCleanupPageRotation;
    excluded: boolean;
    blankOutputsSkipped: number;
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
    pageMetadata: IScanCleanupPreviewPageMetadata;
    outputs: IScanCleanupPreviewOutput[];
}

export interface IScanCleanupDetectionRequest {
    sourcePdfPath: string;
    options: IScanCleanupOptions;
}

export interface IScanCleanupDetectionResult {
    pageNumber: number;
    classification: IScanCleanupPreviewMetadata['layoutClassification'];
    confidence: number;
    cutterX: number | null;
}

export interface IScanCleanupDetectionProgress {
    detectedCount: number;
    totalPages: number;
}

interface IScanCleanupDetectionJobBase {
    jobId: string;
    progress: IScanCleanupDetectionProgress;
    results: IScanCleanupDetectionResult[];
    updatedAtMs: number;
}

export type TScanCleanupDetectionJobState =
    | IScanCleanupDetectionJobBase & {status: 'queued' | 'running' | 'completed' | 'canceled'}
    | IScanCleanupDetectionJobBase & {
        status: 'failed';
        error: string;
        errorCode: TScanCleanupErrorCode
    };

export interface IScanCleanupDetectionStartResult {
    started: boolean;
    jobId: string;
    error?: string;
    errorCode?: TScanCleanupErrorCode;
}

export interface IScanCleanupStartRequest {
    sourcePdfPath: string;
    /** @deprecated Ignored. Generated output paths are always managed by the main process. */
    outputPdfPath?: string;
    options: IScanCleanupOptions;
    runOcrAfterCleanup?: boolean;
}

export interface IScanCleanupSummary {
    inputPages: number;
    outputPages: number;
    spreadsSplit: number;
    offcutsDiscarded: number;
    deskewSkipped: number;
    cropSkipped: number;
    excludedPages: number;
    blankPagesSkipped: number;
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
        summary: IScanCleanupSummary;
        runOcrAfterCleanup: boolean
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
    cancelPreview: (sourcePdfPath: string, invalidateRawCache?: boolean) => Promise<boolean>;
    detectAll: (request: IScanCleanupDetectionRequest) => Promise<IScanCleanupDetectionStartResult>;
    cancelDetection: (jobId: string) => Promise<boolean>;
    getDetectionJobState: (jobId: string) => Promise<TScanCleanupDetectionJobState | null>;
    subscribeDetectionJob: (jobId: string) => Promise<TScanCleanupDetectionJobState | null>;
    start: (request: IScanCleanupStartRequest) => Promise<IScanCleanupStartResult>;
    cancel: (jobId: string) => Promise<boolean>;
    getJobState: (jobId: string) => Promise<TScanCleanupJobState | null>;
    subscribeJob: (jobId: string) => Promise<TScanCleanupJobState | null>;
    reconnectJob: (jobId: string) => Promise<TScanCleanupJobState | null>;
    pruneGeneratedOutputs: (openPdfPaths: string[]) => Promise<number>;
    onJobState: (callback: (state: TScanCleanupJobState) => void) => () => void;
    onDetectionJobState: (callback: (state: TScanCleanupDetectionJobState) => void) => () => void;
}
