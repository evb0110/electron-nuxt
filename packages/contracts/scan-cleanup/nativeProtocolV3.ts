import type {TNativeErrorCode} from '@contracts/nativeErrors';
import type {
    IScanCleanupDocumentPrior,
    IScanCleanupManualZones,
    IScanCleanupTextAxis,
    TScanCleanupBinarizationMethod,
    TScanCleanupCanvasScope,
    TScanCleanupDespeckleLevel,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeRecommendationReason,
    TScanCleanupOutputModeSetting,
    TScanCleanupPageAlignment,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/domain';
import type {
    IScanCleanupMarginsMm,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    IScanCleanupPixelPolygon,
    IScanCleanupSplitSeamPolyline,
} from '@contracts/scan-cleanup/geometry';

export const SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION = 3 as const;

export type TNativeScanCleanupOperation = 'analyze' | 'render';
export type TNativeScanCleanupRenderMode = 'preview' | 'final';

export interface INativeScanCleanupExperimentalOptionsV3 {
    autoDewarp: boolean;
    autoDewarpDepth?: number;
}

export interface INativeScanCleanupOptionsV3 {
    dpi: number;
    sourceDpi: number;
    requestedRenderDpi: number;
    binarization: TScanCleanupBinarizationMethod;
    thickness: number;
    normalizeIllumination: boolean;
    despeckle: boolean;
    despeckleLevel?: TScanCleanupDespeckleLevel;
    outputMode: TScanCleanupOutputModeSetting;
    ocrMode: boolean;
    layout: 'auto' | 'force-single' | 'page-with-offcut' | 'keep-left' | 'keep-right' | 'force-two-page';
    manualSplit: IScanCleanupNormalizedSplit | null;
    manualSkewDegrees?: number;
    manualContentBoxes: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
    manualZones?: IScanCleanupManualZones;
    cropContent: boolean;
    matchPageSize: boolean;
    pageAlignment: TScanCleanupPageAlignment;
    placementOverrides: Partial<Record<TScanCleanupOutputHalf, TScanCleanupPageAlignment>>;
    margins: IScanCleanupMarginsMm;
    experimental: INativeScanCleanupExperimentalOptionsV3;
    rotationDegrees: TScanCleanupPageRotation;
    excluded: boolean;
    skipBlankPages: boolean;
    maxPixels: number;
    maxDimensionPx: number;
}

export interface INativeScanCleanupOutputV3 {
    outputPath: string;
    metadataPath: string;
    bilevelOutputPath?: string;
    backgroundOutputPath?: string;
    foregroundMaskOutputPath?: string;
}

/** Additive geometry returned in page/output metadata by protocol-v3 sidecars. */
export interface INativeScanCleanupSplitResultGeometryV3 {
    cutterXPx: number | null;
    /** Existing straight-cut page polygons. Output metadata always supplies these. */
    splitGeometry?: IScanCleanupPixelPolygon[];
    /** Optional diagnostic seam. Current renderers continue to use the straight cutter. */
    splitSeam?: IScanCleanupSplitSeamPolyline;
}

export interface INativeScanCleanupBinarizationDiagnosticsV3 {
    route: TScanCleanupBinarizationMethod;
    robustContrast: number;
    illuminationDeviation: number;
    edgeDensity: number;
    estimatedStrokeWidthPx: number;
    darkBorderCoverage: number;
    otsuAdaptiveAgreement: number;
}

export interface INativeScanCleanupContentSideConfidenceV3 {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** Optional diagnostics written by render metadata. */
export interface INativeScanCleanupRenderDiagnosticsV3 {
    cutterXPx?: number | null;
    splitGeometry?: IScanCleanupPixelPolygon[];
    splitSeam?: IScanCleanupSplitSeamPolyline;
    detectedSkewDegrees?: number;
    skewConfidence?: number;
    skewApplied?: boolean;
    manualSkew?: boolean;
    layoutConfidence?: number;
    /** Additive split detector abstention signal when supplied by the native implementation. */
    splitAbstained?: boolean;
    binarizationMode?: TScanCleanupBinarizationMethod | null;
    binarizationDiagnostics?: INativeScanCleanupBinarizationDiagnosticsV3 | null;
    despeckleFallback?: boolean;
    dewarpConfidence?: number | null;
    contentDiagnostics?: {sideConfidence: INativeScanCleanupContentSideConfidenceV3};
}

/** Optional diagnostics written beside each analyzed page. */
export interface INativeScanCleanupPageDiagnosticsV3 {
    cutterXPx?: number | null;
    splitGeometry?: IScanCleanupPixelPolygon[];
    splitSeam?: IScanCleanupSplitSeamPolyline;
    layoutConfidence?: number;
    splitAbstained?: boolean;
    tier1Verdict?: TScanCleanupLayoutClassification;
    reconciled?: boolean;
    clusterAgreement?: number;
}

export interface INativeScanCleanupPageV3 {
    inputPath: string;
    sourcePageIndex: number;
    pageMetadataPath: string;
    options: INativeScanCleanupOptionsV3;
    outputs: INativeScanCleanupOutputV3[];
    documentPrior?: IScanCleanupDocumentPrior;
}

export interface INativeScanCleanupManifestV3 {
    version: typeof SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION;
    operation: TNativeScanCleanupOperation;
    renderMode: TNativeScanCleanupRenderMode;
    canvasScope: TScanCleanupCanvasScope;
    documentCanvas?: {
        widthPoints: number;
        heightPoints: number;
    };
    pages: INativeScanCleanupPageV3[];
}

export type TNativeScanCleanupProgressStage =
    | 'started'
    | 'page-analyzed'
    | 'page-complete'
    | 'completed';

export interface INativeScanCleanupPageStageTimingsV3 {
    decodeMs?: number;
    analysisLevelMs?: number;
    normalizationMs?: number;
    splitMs?: number;
    deskewMs?: number;
    contentMs?: number;
    renderMs?: number;
    writeMs?: number;
}

export interface INativeScanCleanupProgressV3 {
    stage: TNativeScanCleanupProgressStage;
    completedPages: number;
    totalPages: number;
    pageNumber?: number;
    outputPaths?: string[];
    classification?: TScanCleanupLayoutClassification;
    confidence?: number;
    cutterXPx?: number;
    tier1Verdict?: TScanCleanupLayoutClassification;
    reconciled?: boolean;
    clusterAgreement?: number;
    documentPrior?: IScanCleanupDocumentPrior;
    textAxis?: IScanCleanupTextAxis;
    stageTimings?: INativeScanCleanupPageStageTimingsV3;
    recommendedOutputMode?: TScanCleanupOutputMode;
    recommendedOutputModeConfidence?: number;
    recommendedOutputModeReason?: TScanCleanupOutputModeRecommendationReason;
}

export interface INativeScanCleanupProgressEnvelopeV3 {
    version: typeof SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION;
    type: 'progress';
    progress: INativeScanCleanupProgressV3;
}

export type TNativeScanCleanupResultV3 =
    | {
        status: 'success';
        completedPages: number;
        totalPages: number
    }
    | {
        status: 'failure';
        code: TNativeErrorCode;
        message: string
    };

export interface INativeScanCleanupResultEnvelopeV3 {
    version: typeof SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION;
    type: 'result';
    result: TNativeScanCleanupResultV3;
}

export type TNativeScanCleanupEnvelopeV3 =
    | INativeScanCleanupProgressEnvelopeV3
    | INativeScanCleanupResultEnvelopeV3;
