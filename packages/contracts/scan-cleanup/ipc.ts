import type {TNativeErrorCode} from '@contracts/nativeErrors';
import type {
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    IScanCleanupReconciliationMetadata,
    IScanCleanupTextAxis,
    TScanCleanupBinarizationMethod,
    TScanCleanupCanvasScope,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputMode,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/domain';
import type {
    IScanCleanupAppliedMargins,
    IScanCleanupPixelRect,
    IScanCleanupPreviewAffine,
    IScanCleanupSplitSeamPolyline,
} from '@contracts/scan-cleanup/geometry';
import type {INativeScanCleanupBinarizationDiagnosticsV3} from '@contracts/scan-cleanup/nativeProtocolV3';
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
    documentCanvasPlan?: IScanCleanupDocumentCanvasPlan;
}

export interface IScanCleanupPreviewCancelRequest extends IScanCleanupOwnerContext {
    sourcePdfPath: string;
    invalidateRawCache?: boolean;
}

export type TScanCleanupCanvasPolicy = 'intrinsic' | 'strict-maximum';

export interface IScanCleanupDocumentCanvasPlan {
    widthPoints: number;
    heightPoints: number;
}

export interface IScanCleanupContentSideConfidence {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface IScanCleanupContentTextMaskSummary {
    analysisWidthPx: number;
    analysisHeightPx: number;
    inkPixels: number;
    lineCount: number;
    bounds?: IScanCleanupPixelRect;
}

export type TScanCleanupContentTrimSide = 'left' | 'top' | 'right' | 'bottom';

export interface IScanCleanupContentBlockEvidence {
    bounds: IScanCleanupPixelRect;
    pictureMaskOverlapPixels: number;
    headingEvidence: boolean;
    grayscaleEvidence: boolean;
}

export interface IScanCleanupContentAcceptedTrim {
    side: TScanCleanupContentTrimSide;
    iteration: number;
    score: number;
    threshold: number;
    contentDistanceSum: number;
    garbageDistanceSum: number;
    removedBlocks: IScanCleanupContentBlockEvidence[];
}

export interface IScanCleanupContentDiagnostics {
    sideConfidence: IScanCleanupContentSideConfidence;
    textMask: IScanCleanupContentTextMaskSummary;
    acceptedTrims?: IScanCleanupContentAcceptedTrim[];
    protectedBlocks?: IScanCleanupContentBlockEvidence[];
}

export interface IScanCleanupBinarizationDiagnostics extends INativeScanCleanupBinarizationDiagnosticsV3 {}

/** Renderer-facing per-page diagnostic summary assembled from page and first-output metadata. */
export interface IScanCleanupPageDiagnostics {
    detectedSkewDegrees?: number;
    skewConfidence?: number;
    manualSkew?: boolean;
    binarizationMode?: TScanCleanupBinarizationMethod | null;
    binarizationDiagnostics?: IScanCleanupBinarizationDiagnostics | null;
    despeckleFallback?: boolean;
    autoDewarpAttempted?: boolean;
    dewarpApplied?: boolean;
    dewarpConfidence?: number | null;
    contentSideConfidence?: IScanCleanupContentSideConfidence;
}

export interface IScanCleanupPreviewMetadata {
    half: 'full' | 'left' | 'right';
    layoutClassification: TScanCleanupLayoutClassification;
    layoutConfidence: number;
    detectedSkewDegrees?: number;
    skewConfidence?: number;
    skewApplied?: boolean;
    manualSkew?: boolean;
    sourceRegion: IScanCleanupPixelRect;
    contentBox: IScanCleanupPixelRect | null;
    /** Applied crop in deskewed/dewarped page-region coordinates; absent in older metadata. */
    cropRect?: IScanCleanupPixelRect;
    /** Optional for metadata produced before native protocol v2 gained A4 diagnostics. */
    contentDiagnostics?: IScanCleanupContentDiagnostics;
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
    matchedCanvasTargetWidthPoints?: number | null;
    matchedCanvasTargetHeightPoints?: number | null;
    /** Intrinsic raster origin within the logical canvas. */
    placementOffsetXPx: number;
    placementOffsetYPx: number;
    /** Maps rotated analysis-page coordinates into intrinsic cleaned-raster coordinates. */
    forwardTransform: IScanCleanupPreviewAffine | null;
    cutterXPx: number | null;
    splitSeam?: IScanCleanupSplitSeamPolyline;
    splitAbstained?: boolean;
    inputWidthPx: number;
    inputHeightPx: number;
    rotationDegrees: TScanCleanupPageRotation;
    canvasScope: TScanCleanupCanvasScope;
    resamplePasses: number;
    sourceDpi?: number;
    renderDpi?: number;
    requestedRenderDpi?: number;
    rasterScaleLimited?: boolean;
    /** True when multiplicative illumination normalization affected the rendered raster. */
    illuminationNormalized?: boolean;
    binarizationMode?: TScanCleanupBinarizationMethod | null;
    binarizationDiagnostics?: IScanCleanupBinarizationDiagnostics | null;
    /** True when despeckle used top-decile fallback anchors because the page had no calibrated seed. */
    despeckleFallback?: boolean;
    dewarpConfidence?: number | null;
    /** Derived by Electron from native dewarp metadata. */
    dewarpApplied?: boolean;
    warnings: string[];
}

export interface IScanCleanupPreviewPageMetadata extends IScanCleanupReconciliationMetadata, IScanCleanupPageDiagnostics {
    layoutClassification: IScanCleanupPreviewMetadata['layoutClassification'];
    layoutConfidence?: number;
    cutterXPx: number | null;
    splitSeam?: IScanCleanupSplitSeamPolyline;
    splitAbstained?: boolean;
    rotationDegrees: TScanCleanupPageRotation;
    canvasScope: TScanCleanupCanvasScope;
    excluded: boolean;
    blankOutputsSkipped: number;
    recommendedOutputMode?: TScanCleanupOutputMode;
    recommendedOutputModeConfidence?: number;
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
    recommendedOutputMode?: TScanCleanupOutputMode;
    recommendedOutputModeConfidence?: number;
}

interface IScanCleanupDetectionJobBase {
    jobId: string;
    progress: IScanCleanupProgress;
    results: IScanCleanupDetectionResult[];
    documentCanvasPlan?: IScanCleanupDocumentCanvasPlan;
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
    outputModeRecommendations?: Partial<Record<string, TScanCleanupOutputMode>>;
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
