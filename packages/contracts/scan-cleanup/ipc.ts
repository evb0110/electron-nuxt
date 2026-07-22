import type {TNativeErrorCode} from '@contracts/nativeErrors';
import type {
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    IScanCleanupReconciliationMetadata,
    IScanCleanupTextAxis,
    TScanCleanupCanvasScope,
    TScanCleanupLayoutClassification,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/domain';
import type {
    IScanCleanupAppliedMargins,
    IScanCleanupPixelRect,
    IScanCleanupPreviewAffine,
} from '@contracts/scan-cleanup/geometry';
import type {IScanCleanupProgress} from '@contracts/scan-cleanup/progress';

export interface IScanCleanupOwnerContext {
    /** Stable for one renderer tab/session; Electron combines this with the sending WebContents id. */
    ownerId: string;
    /** Revision token (or mtime-derived token) fencing every recomputable artifact and job. */
    documentRevision: string;
}

export type TScanCleanupErrorCode =
    | TNativeErrorCode
    | 'tools-unavailable'
    | 'canceled'
    | 'internal';

export interface IScanCleanupPreviewRequest extends IScanCleanupOwnerContext {
    sourcePdfPath: string;
    pageNumber: number;
    options: IScanCleanupOptions;
    documentPrior?: IScanCleanupDocumentPrior;
}

export interface IScanCleanupPreviewCancelRequest extends IScanCleanupOwnerContext {
    sourcePdfPath: string;
    invalidateRawCache?: boolean;
}

export type TScanCleanupCanvasPolicy = 'intrinsic' | 'robust-quantile' | 'overflow-intrinsic';

export interface IScanCleanupPreviewMetadata {
    half: 'full' | 'left' | 'right';
    layoutClassification: TScanCleanupLayoutClassification;
    layoutConfidence: number;
    sourceRegion: IScanCleanupPixelRect;
    contentBox: IScanCleanupPixelRect | null;
    appliedMargins: IScanCleanupAppliedMargins;
    /** Intrinsic dimensions of the unpadded cleaned raster. */
    outputWidthPx: number;
    outputHeightPx: number;
    /** Logical matched-page canvas dimensions; never smaller than the intrinsic raster. */
    canvasWidthPx: number;
    canvasHeightPx: number;
    /** Matched-canvas decision; optional only for metadata written by older native binaries. */
    canvasPolicy?: TScanCleanupCanvasPolicy;
    canvasOverflow?: boolean;
    matchedCanvasTargetWidthPx?: number | null;
    matchedCanvasTargetHeightPx?: number | null;
    /** Intrinsic raster origin within the logical canvas. */
    placementOffsetXPx: number;
    placementOffsetYPx: number;
    /** Maps rotated analysis-page coordinates into intrinsic cleaned-raster coordinates. */
    forwardTransform: IScanCleanupPreviewAffine | null;
    cutterXPx: number | null;
    inputWidthPx: number;
    inputHeightPx: number;
    rotationDegrees: TScanCleanupPageRotation;
    canvasScope: TScanCleanupCanvasScope;
    resamplePasses: number;
    /** True when multiplicative illumination normalization affected the rendered raster. */
    illuminationNormalized?: boolean;
    /** True when despeckle used top-decile fallback anchors because the page had no calibrated seed. */
    despeckleFallback?: boolean;
    warnings: string[];
}

export interface IScanCleanupPreviewPageMetadata extends IScanCleanupReconciliationMetadata {
    layoutClassification: IScanCleanupPreviewMetadata['layoutClassification'];
    layoutConfidence: number;
    cutterXPx: number | null;
    rotationDegrees: TScanCleanupPageRotation;
    canvasScope: TScanCleanupCanvasScope;
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
    rawWidthPx: number;
    rawHeightPx: number;
    pageMetadata: IScanCleanupPreviewPageMetadata;
    outputs: IScanCleanupPreviewOutput[];
}

export interface IScanCleanupDetectionRequest extends IScanCleanupOwnerContext {
    sourcePdfPath: string;
    options: IScanCleanupOptions;
}

export interface IScanCleanupDetectionResult extends IScanCleanupReconciliationMetadata {
    pageNumber: number;
    classification: IScanCleanupPreviewMetadata['layoutClassification'];
    confidence: number;
    cutterXPx: number | null;
    documentPrior: IScanCleanupDocumentPrior | null;
    textAxis?: IScanCleanupTextAxis;
}

interface IScanCleanupDetectionJobBase {
    jobId: string;
    progress: IScanCleanupProgress;
    results: IScanCleanupDetectionResult[];
    updatedAtMs: number;
}

export type TScanCleanupDetectionJobState =
    | IScanCleanupDetectionJobBase & {status: 'queued' | 'running' | 'canceling' | 'completed' | 'canceled'}
    | IScanCleanupDetectionJobBase & {
        status: 'failed';
        error: string;
        errorCode: TScanCleanupErrorCode
    };

export type TScanCleanupDetectionStartResult =
    | {
        started: true;
        jobId: string
    }
    | {
        started: false;
        jobId: string;
        error: string;
        errorCode: TScanCleanupErrorCode
    };

export interface IScanCleanupStartRequest extends IScanCleanupOwnerContext {
    sourcePdfPath: string;
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

interface IScanCleanupJobBase {
    jobId: string;
    progress: IScanCleanupProgress;
    updatedAtMs: number;
}

export type TScanCleanupJobState =
    | IScanCleanupJobBase & {status: 'queued' | 'running' | 'canceling' | 'handoff'}
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

export type TScanCleanupStartResult =
    | {
        started: true;
        jobId: string;
        outputPdfPath: string
    }
    | {
        started: false;
        jobId: string;
        error: string;
        errorCode: TScanCleanupErrorCode
    };

export interface IScanCleanupCapability {
    preview: (request: IScanCleanupPreviewRequest) => Promise<IScanCleanupPreviewResult>;
    cancelPreview: (request: IScanCleanupPreviewCancelRequest) => Promise<boolean>;
    detectAll: (request: IScanCleanupDetectionRequest) => Promise<TScanCleanupDetectionStartResult>;
    cancelDetection: (jobId: string, owner: IScanCleanupOwnerContext) => Promise<boolean>;
    getDetectionJobState: (jobId: string, owner: IScanCleanupOwnerContext) => Promise<TScanCleanupDetectionJobState | null>;
    subscribeDetectionJob: (jobId: string, owner: IScanCleanupOwnerContext) => Promise<TScanCleanupDetectionJobState | null>;
    start: (request: IScanCleanupStartRequest) => Promise<TScanCleanupStartResult>;
    cancel: (jobId: string, owner: IScanCleanupOwnerContext) => Promise<boolean>;
    getJobState: (jobId: string, owner: IScanCleanupOwnerContext) => Promise<TScanCleanupJobState | null>;
    subscribeJob: (jobId: string, owner: IScanCleanupOwnerContext) => Promise<TScanCleanupJobState | null>;
    reconnectJob: (jobId: string, owner: IScanCleanupOwnerContext) => Promise<TScanCleanupJobState | null>;
    pruneGeneratedOutputs: (openPdfPaths: string[]) => Promise<number>;
    onJobState: (callback: (state: TScanCleanupJobState) => void) => () => void;
    onDetectionJobState: (callback: (state: TScanCleanupDetectionJobState) => void) => () => void;
}
