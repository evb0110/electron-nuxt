import type {TNativeErrorCode} from '@contracts/nativeErrors';
import type {
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    IScanCleanupReconciliationMetadata,
    IScanCleanupTextAxis,
    TScanCleanupBinarizationMethod,
    TScanCleanupCanvasScope,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeRecommendationReason,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/domain';
import type {
    IScanCleanupAppliedMargins,
    IScanCleanupNormalizedRect,
    IScanCleanupPixelRect,
    IScanCleanupPreviewAffine,
    IScanCleanupSplitSeamPolyline,
} from '@contracts/scan-cleanup/geometry';
import type {INativeScanCleanupBinarizationDiagnosticsV3} from '@contracts/scan-cleanup/nativeProtocolV3';
import type {TScanCleanupProgress} from '@contracts/scan-cleanup/progress';
import {
    runtimeSchema,
    type TInferSchema,
} from '@contracts/platformFeature';

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
    detail?: {
        /** Renderer-visible regions keyed by final output half; drives crop rendering and tile identity. */
        viewports: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
        outputMode: TScanCleanupOutputMode;
    };
}

export interface IScanCleanupRawPreviewRequest extends IScanCleanupOwnerContext {
    sourcePdfPath: string;
    pageNumber: number;
}

export interface IScanCleanupRawPreviewResult {
    pageNumber: number;
    totalPages: number;
    rawImageData: Uint8Array;
    rawWidthPx: number;
    rawHeightPx: number;
}

export interface IScanCleanupPreviewCancelRequest extends IScanCleanupOwnerContext {
    sourcePdfPath: string;
    invalidateRawCache?: boolean;
    /**
     * Pages whose cleaned preview work the renderer still wants. A navigation
     * names the window it is moving into so the work already running for those
     * pages survives instead of being restarted; omitting it cancels the whole
     * document, which is what a settings change or a closing session means.
     */
    retainPages?: readonly number[];
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
    outputDiagnostics?: IScanCleanupPageOutputDiagnostics[];
    recommendedOutputModeReason?: TScanCleanupOutputModeRecommendationReason;
}

export interface IScanCleanupPageOutputDiagnostics {
    half: TScanCleanupOutputHalf;
    contentDiagnostics?: IScanCleanupContentDiagnostics;
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
    /**
     * Actual image payload bounds inside the intrinsic cleaned raster.
     * Absent payloads cover the complete intrinsic raster.
     */
    renderRegion?: IScanCleanupPixelRect;
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
    recommendedOutputModeReason?: TScanCleanupOutputModeRecommendationReason;
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
    recommendedOutputModeReason?: TScanCleanupOutputModeRecommendationReason;
}

interface IScanCleanupDetectionJobBase {
    jobId: string;
    progress: TScanCleanupProgress;
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
    /** Ordered one-based source pages included in this output. Omitted means the full document. */
    sourcePageNumbers?: number[];
    outputModeRecommendations?: Partial<Record<string, TScanCleanupOutputMode>>;
}

const s = runtimeSchema;
const summaryCount = s.number({
    integer: true,
    min: 0,
    message: 'invalid scan-cleanup summary',
});
export const SCAN_CLEANUP_SUMMARY_SCHEMA = s.object({
    inputPages: summaryCount,
    outputPages: summaryCount,
    spreadsSplit: summaryCount,
    offcutsDiscarded: summaryCount,
    deskewSkipped: summaryCount,
    cropSkipped: summaryCount,
    excludedPages: summaryCount,
    blankPagesSkipped: summaryCount,
    warnings: s.array(s.string()),
});
export type TScanCleanupSummary = TInferSchema<typeof SCAN_CLEANUP_SUMMARY_SCHEMA>;

interface IScanCleanupJobBase {
    jobId: string;
    progress: TScanCleanupProgress;
    updatedAtMs: number;
}

export type TScanCleanupJobState =
    | IScanCleanupJobBase & {status: 'queued' | 'running' | 'canceling' | 'handoff'}
    | IScanCleanupJobBase & {
        status: 'completed';
        outputPdfPath: string;
        summary: TScanCleanupSummary;
        partial: boolean
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
