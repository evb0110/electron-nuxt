import {NATIVE_ERROR_CODES} from '@contracts/nativeErrors';
import {
    runtimeSchema,
    type TInferSchema,
} from '@contracts/platformFeature';
import {isRecord} from '@contracts/runtimeGuards';
import type {
    IScanCleanupDocumentPrior,
    IScanCleanupManualZones,
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
    IScanCleanupPixelPoint,
    IScanCleanupPixelPolygon,
    IScanCleanupPixelRect,
    IScanCleanupPreviewAffine,
    IScanCleanupSplitSeamPolyline,
} from '@contracts/scan-cleanup/geometry';

export const SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION = 3 as const;

export type TNativeScanCleanupOperation = 'analyze' | 'render';
export type TNativeScanCleanupRenderMode = 'preview' | 'final';
export type TNativeScanCleanupAnalysisPurpose = 'classification' | 'page-plan';

export interface INativeScanCleanupExperimentalOptionsV3 {
    autoDewarp: boolean;
    autoDewarpDepth?: number;
}

export interface INativeScanCleanupOptionsV3 {
    dpi: number;
    sourceDpi: number;
    sourceHasBilevelLayer?: boolean;
    sourceBackgroundDpi?: number;
    requestedRenderDpi: number;
    /**
     * Optional preview-only tile in normalized final intrinsic-output space.
     * Absence preserves the protocol-v3 full-page render contract.
     */
    renderCrop?: IScanCleanupNormalizedRect;
    binarization: TScanCleanupBinarizationMethod;
    thickness: number;
    normalizeIllumination: boolean;
    despeckle: boolean;
    despeckleLevel?: TScanCleanupDespeckleLevel;
    outputMode: TScanCleanupOutputModeSetting;
    /** Locked Auto decision for Mixed-layer foreground encoding. */
    preferSoftAlphaForeground?: boolean;
    resolvedTextToneDiagnostics?: Partial<
        Record<TScanCleanupOutputHalf, INativeScanCleanupTextToneDiagnosticsV3>
    >;
    ocrMode: boolean;
    layout: 'auto' | 'force-single' | 'page-with-offcut' | 'keep-left' | 'keep-right' | 'force-two-page';
    manualSplit: IScanCleanupNormalizedSplit | null;
    /**
     * Trusted automatic cutter from a base preview with the same settings.
     * Kept distinct from manualSplit so replay never becomes a user edit.
     */
    automaticSplit?: IScanCleanupNormalizedSplit;
    manualSkewDegrees?: number;
    manualContentBoxes: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
    /**
     * Trusted automatic geometry from a base preview with the same settings.
     * Manual values above take precedence. Kept distinct so native metadata
     * never labels replayed automatic analysis as a user edit.
     */
    automaticSkewDegrees?: Partial<Record<TScanCleanupOutputHalf, number>>;
    automaticContentBoxes?: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
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
    foregroundAlphaOutputPath?: string;
    pictureMaskOutputPath?: string;
    tonePreservationAlphaOutputPath?: string;
}

export interface INativeScanCleanupPdfImagePlacementV3 {
    xPoints: number;
    yPoints: number;
    widthPoints: number;
    heightPoints: number;
}

export interface INativeScanCleanupDewarpModelV3 {
    topCurve: IScanCleanupPixelPoint[];
    bottomCurve: IScanCleanupPixelPoint[];
    depth: number;
}

/** Metadata written beside each protocol-v3 rendered output. */
export interface INativeScanCleanupOutputMetadataV3 {
    sourcePageIndex?: number;
    half?: TScanCleanupOutputHalf;
    sourceRegion?: IScanCleanupPixelRect;
    cropRect?: IScanCleanupPixelRect;
    inputWidthPx?: number;
    inputHeightPx?: number;
    outputWidthPx: number;
    outputHeightPx: number;
    intrinsicRasterWidthPx?: number;
    intrinsicRasterHeightPx?: number;
    canvasWidthPx: number;
    canvasHeightPx: number;
    layoutClassification: TScanCleanupLayoutClassification;
    splitSeam?: IScanCleanupSplitSeamPolyline;
    splitAbstained?: boolean;
    detectedSkewDegrees?: number;
    skewConfidence?: number;
    skewApplied: boolean;
    manualSkew?: boolean;
    bilevelWritten?: boolean;
    layeredWritten?: boolean;
    layeredForegroundKind?: 'stencil' | 'soft-alpha' | 'source-mrc';
    layeredBackgroundDpi?: number;
    layeredForegroundDpi?: number;
    trustedMrcBackgroundPreserved?: boolean;
    illuminationNormalized?: boolean;
    textToneDiagnostics?: INativeScanCleanupTextToneDiagnosticsV3;
    binarizationMode?: TScanCleanupBinarizationMethod | null;
    binarizationDiagnostics?: INativeScanCleanupBinarizationDiagnosticsV3 | null;
    outputMode?: TScanCleanupOutputMode;
    despeckleFallback?: boolean;
    dewarpConfidence?: number | null;
    dewarpModel?: INativeScanCleanupDewarpModelV3 | null;
    contentBox?: IScanCleanupPixelRect | null;
    warnings?: string[];
    renderDpi?: number;
    matchedCanvasTargetWidthPoints?: number | null;
    matchedCanvasTargetHeightPoints?: number | null;
    matchedCanvasContentWidthPx?: number | null;
    matchedCanvasContentHeightPx?: number | null;
    /** True when the transformed optical content, rather than the retained raster rectangle, owns horizontal placement. */
    matchedCanvasOpticalPlacement?: boolean;
    matchedCanvasOpticalContentLeftPx?: number | null;
    matchedCanvasOpticalContentRightPx?: number | null;
    matchedCanvasIntrinsicOverflowLeftPx?: number;
    matchedCanvasIntrinsicOverflowRightPx?: number;
    matchedCanvasIntrinsicOverflowTopPx?: number;
    /** Canvas-grid columns excluded from the preview/final source window at the fold edge. */
    foldClipLeftPx?: number;
    foldClipRightPx?: number;
    /** Optional source-grid continuous-tone rectangle in PDF user-space points. */
    pdfImagePlacement?: INativeScanCleanupPdfImagePlacementV3;
    placementOffsetXPx: number;
    placementOffsetYPx: number;
    forwardTransform: IScanCleanupPreviewAffine | null;
    dewarpMapping?: INativeScanCleanupReusableGeometryV3['dewarpMapping'];
    rotationDegrees: TScanCleanupPageRotation;
}

export type TNativeScanCleanupTextToneRuleV3 =
    | 'applied'
    | 'picture-evidence'
    | 'insufficient-text'
    | 'tonal-mass-outside-text'
    | 'already-dark';

export interface INativeScanCleanupTextToneDiagnosticsV3 {
    applied: boolean;
    rule: TNativeScanCleanupTextToneRuleV3;
    textLineCount: number;
    textInkPixels: number;
    pictureFraction: number;
    outsideMidtoneFraction: number;
    outsideMidtoneLargestComponentFraction: number;
    outsideMidtoneLargestComponentWidthFraction: number;
    outsideMidtoneLargestComponentHeightFraction: number;
    inkAnchor: number | null;
    blackPoint: number | null;
    slope: number | null;
}

export interface INativeScanCleanupAnalysisOutputV3 {
    half: TScanCleanupOutputHalf;
    contentBox?: IScanCleanupPixelRect | null;
    textToneDiagnostics?: INativeScanCleanupTextToneDiagnosticsV3;
    cropRect: IScanCleanupPixelRect;
    sourceRegion: IScanCleanupPixelRect;
    inputWidthPx: number;
    inputHeightPx: number;
}

export interface INativeScanCleanupOutputModeDiagnosticsV3 {
    rule:
        | 'blank'
        | 'color-text-with-pictures'
        | 'color'
        | 'text-with-pictures'
        | 'picture'
        | 'sparse-text'
        | 'continuous-tone'
        | 'confident-text'
        | 'dense-text'
        | 'strong-single-line-text'
        | 'spatial-tone'
        | 'bilevel-fidelity'
        | 'uncertain-fallback';
    fallbackUsed: boolean;
    analysisWidth: number;
    analysisHeight: number;
    otsuThreshold: number;
    darkMean: number;
    lightMean: number;
    midtoneLower: number;
    midtoneUpper: number;
    p01: number;
    p50: number;
    p99: number;
    bimodality: number;
    midtoneFraction: number;
    relativeMidtoneFraction: number;
    modeDistance: number;
    inkFraction: number;
    edgeFraction: number;
    robustLuminanceRange: number;
    coloredFraction: number;
    largestColorComponentPixels: number;
    meanSaturation: number;
    pictureFraction: number;
    textLineCount: number;
    significantColor: boolean;
    significantPicture: boolean;
    pictureGateMargin: number;
    tonalMidtoneGateMargin: number;
    strongBimodalityGateMargin: number;
    confidentTextBimodalityMargin: number;
    confidentTextModeDistanceMargin: number;
    confidentTextMidtoneMargin: number;
    denseTextLineMargin: number;
    denseTextBimodalityMargin: number;
    denseTextModeDistanceMargin: number;
    denseTextMidtoneMargin: number;
    outsideTonalFraction: number;
    outsideTonalLargestComponentFraction: number;
    outsideTonalLargestComponentWidthFraction: number;
    outsideTonalLargestComponentHeightFraction: number;
    coherentOutsideTonalRegion: boolean;
    destructiveModeTonalVeto: boolean;
    sourceDpi: number;
    analysisDpi: number;
    calibratedSourceStrokeWidthPx: number;
    calibratedSourceXHeightPx: number;
    softEdgeToInkRatio: number;
    bilevelFidelityVeto: boolean;
}

/** Gate-level evidence behind the native spread/single decision. */
export type TNativeScanCleanupFoldBandUnmeasuredReasonV3 =
    | 'not-applicable'
    | 'no-fold-evidence'
    | 'fold-evidence-unquantified'
    | 'cutter-invalidated'
    | 'measurement-unavailable';

export type TNativeScanCleanupFoldBandV3 =
    | {
        status: 'measured';
        leftXPx: number;
        rightXPx: number;
    }
    | {
        status: 'unmeasured';
        reason: TNativeScanCleanupFoldBandUnmeasuredReasonV3;
        nominalHalfWidthPx: number;
    };

export interface INativeScanCleanupSplitDiagnosticsV3 {
    analysisDpi: number;
    deskewAngleDegrees: number;
    deskewConfidence: number;
    cutterSlope: number;
    leftDeskewAngleDegrees: number;
    rightDeskewAngleDegrees: number;
    leftDeskewConfidence: number;
    rightDeskewConfidence: number;
    whitespaceX: number;
    foldX: number;
    decisionX: number;
    whitespaceScore: number;
    bilateralScore: number;
    leftPageScore: number;
    rightPageScore: number;
    leftContentScore: number;
    rightContentScore: number;
    leftSurfaceScore: number;
    rightSurfaceScore: number;
    leftInkPixels: number;
    rightInkPixels: number;
    outerMarginScore: number;
    gutterScore: number;
    agreementScore: number;
    foldScore: number;
    gutterDarknessScore: number;
    softGutterScore: number;
    softGutterCoverage: number;
    softGutterContinuity: number;
    softGutterMeanDepression: number;
    sparseGutterScore: number;
    sparseGutterCoverage: number;
    sparseGutterContinuity: number;
    sparseGutterMeanDepression: number;
    aspectRatio: number;
    aspectSpreadScore: number;
    aspectSingleScore: number;
    independentSpreadCues: number;
    offcutBoundaryScore: number;
    offcutEmptyScore: number;
    offcutPopulatedScore: number;
    offcutWidthScore: number;
    offcutNoTextRowsScore: number;
    alternativeProduct: number;
    evidenceProduct: number;
    whitespaceGatePassed: boolean;
    centralPositionGatePassed: boolean;
    bilateralGatePassed: boolean;
    outerMarginGatePassed: boolean;
    gutterGatePassed: boolean;
    independentGutterGatePassed: boolean;
    aspectSupportGatePassed: boolean;
    evidenceAgreementGatePassed: boolean;
    sparseSpreadRecovered: boolean;
    abstained: boolean;
    foldBand: TNativeScanCleanupFoldBandV3;
}

/** Metadata written once for every page in a protocol-v3 batch. */
export interface INativeScanCleanupPageMetadataV3 {
    layoutClassification: TScanCleanupLayoutClassification;
    layoutConfidence?: number;
    cutterXPx: number | null;
    splitSeam?: IScanCleanupSplitSeamPolyline;
    splitAbstained?: boolean;
    rotationDegrees: TScanCleanupPageRotation;
    canvasScope: TScanCleanupCanvasScope;
    excluded: boolean;
    blankOutputsSkipped: number;
    outputCount: number;
    outputs?: INativeScanCleanupAnalysisOutputV3[];
    recommendedOutputMode?: TScanCleanupOutputMode;
    recommendedOutputModeConfidence?: number;
    recommendedOutputModeReason?: TScanCleanupOutputModeRecommendationReason;
    softAlphaForegroundRecommendation?: boolean;
    outputModeDiagnostics?: INativeScanCleanupOutputModeDiagnosticsV3;
    splitDiagnostics?: INativeScanCleanupSplitDiagnosticsV3;
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
    /** The spread-loop decision that supplied the route and threshold scale. */
    spreadPlan?: INativeScanCleanupSpreadBinarizationPlanDiagnosticsV3;
}

export type TNativeScanCleanupSpreadBinarizationPlanDecisionV3 =
    | 'sharedJoint'
    | 'perLeafRouteMismatch'
    | 'perLeafAnchorDrift'
    | 'perLeafRadiusDrift'
    | 'perLeafFaintInkDrift';

export interface INativeScanCleanupSpreadBinarizationPlanDiagnosticsV3 {
    route: TScanCleanupBinarizationMethod;
    thresholdAnchor: number;
    thresholdRadius: number;
    strokeWidthAnchorPx: number;
    xHeightAnchorPx: number;
    documentAnchor: boolean;
    jointCandidateRoute: TScanCleanupBinarizationMethod;
    leftCandidateRoute: TScanCleanupBinarizationMethod;
    rightCandidateRoute: TScanCleanupBinarizationMethod;
    decision: TNativeScanCleanupSpreadBinarizationPlanDecisionV3;
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

export interface INativeScanCleanupDetailRenderPlanV3 {
    /** Trusted metadata from the completed 150-DPI base preview. */
    baseMetadataPath: string;
    /** Full 150-DPI source raster used to reuse page-global processing models. */
    baseRasterPath: string;
    /** Canonical base-preview pixels whose transfer the detail tile replays. */
    baseCleanedRasterPath?: string;
    /** Actual Poppler crop in full, unrotated source-raster pixels at detail DPI. */
    sourceCrop: IScanCleanupPixelRect;
    fullSourceWidthPx: number;
    fullSourceHeightPx: number;
    /** Detail pixels per base-preview pixel. */
    scale: number;
    /** Requested payload bounds in final intrinsic-output pixels at detail DPI. */
    renderRegion: IScanCleanupPixelRect;
    /** Geometry/processing apron rendered before trimming to renderRegion. */
    sampledRegion: IScanCleanupPixelRect;
}

/** Native-only inverse geometry persisted beside a preview output for detail reuse. */
export interface INativeScanCleanupReusableGeometryV3 {
    inverseTransform?: IScanCleanupPreviewAffine;
    dewarpMapping?: {
        columns: number;
        rows: number;
        outputOrigin: IScanCleanupPixelPoint;
        outputWidth: number;
        outputHeight: number;
        outputToSource: IScanCleanupPixelPoint[];
        sourceToOutput: IScanCleanupPixelPoint[];
    } | null;
}

export interface INativeScanCleanupPageV3 {
    inputPath: string;
    /**
     * One-bit PDF soft mask extracted from a compact MRC source. White samples
     * select trusted foreground pixels; native maps it through the same page
     * geometry as inputPath instead of trying to rediscover glyphs.
     */
    trustedForegroundMaskPath?: string;
    /**
     * Native-resolution continuous-tone background extracted from the same
     * compact MRC page as trustedForegroundMaskPath.
     */
    trustedMrcBackgroundPath?: string;
    sourcePageIndex: number;
    pageMetadataPath: string;
    options: INativeScanCleanupOptionsV3;
    outputs: INativeScanCleanupOutputV3[];
    documentPrior?: IScanCleanupDocumentPrior;
    detailRenderPlan?: INativeScanCleanupDetailRenderPlanV3;
}

export interface INativeScanCleanupManifestV3 {
    version: typeof SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION;
    operation: TNativeScanCleanupOperation;
    /**
     * Classification omits content/crop planning that no detection consumer
     * reads. Page-plan is the default for compatibility and for lossless
     * previews, which do consume those output rectangles.
     */
    analysisPurpose?: TNativeScanCleanupAnalysisPurpose;
    renderMode: TNativeScanCleanupRenderMode;
    canvasScope: TScanCleanupCanvasScope;
    documentCanvas?: {
        widthPoints: number;
        heightPoints: number;
        widthPx: number;
        heightPx: number;
    };
    /**
     * Physical memory of this host. The sidecar has no portable way to read it,
     * so it sizes its worker pool and stage cache from this figure instead.
     */
    hostMemoryBytes?: number;
    /**
     * Maximum number of streamed raster materializations that may be live
     * while native page processing remains serial. Omitted direct-CLI
     * manifests retain the one-page turnstile.
     */
    rasterWindow?: number;
    pages: INativeScanCleanupPageV3[];
}

const s = runtimeSchema;
const nonNegativeInteger = (message: string) => s.number({
    integer: true,
    min: 0,
    message,
});
const confidence = (message: string) => s.number({
    min: 0,
    max: 1,
    message,
});
const classification = s.oneOf([
    'single-uncut-page',
    'page-with-offcut',
    'two-page-spread',
] as const, 'Invalid evb-scan-cleanup progress classification');
const documentPrior = s.refine(s.object({
    dominantLayout: classification,
    cutterRatioMedian: s.nullable(s.number({
        min: 0.2,
        max: 0.8,
        message: 'Invalid evb-scan-cleanup document prior',
    })),
    clusterDims: s.object({
        widthPx: s.number({
            min: Number.MIN_VALUE,
            message: 'Invalid evb-scan-cleanup document prior',
        }),
        heightPx: s.number({
            min: Number.MIN_VALUE,
            message: 'Invalid evb-scan-cleanup document prior',
        }),
    }, {
        exact: true,
        message: 'Invalid evb-scan-cleanup document prior',
    }),
    agreementStrength: confidence('Invalid evb-scan-cleanup document prior'),
    strokeWidthMedianPx: s.optional(s.number({
        min: Number.MIN_VALUE,
        message: 'Invalid evb-scan-cleanup document prior',
    })),
    xHeightMedianPx: s.optional(s.number({
        min: Number.MIN_VALUE,
        message: 'Invalid evb-scan-cleanup document prior',
    })),
}, {
    exact: true,
    message: 'Invalid evb-scan-cleanup document prior',
}), value =>
    value.dominantLayout !== 'two-page-spread' || value.cutterRatioMedian !== null,
'Invalid evb-scan-cleanup document prior');
const textAxis = s.object({
    sideways: s.boolean(),
    confidence: confidence('Invalid evb-scan-cleanup text axis'),
}, {
    exact: true,
    message: 'Invalid evb-scan-cleanup text axis',
});
const pageStageTimings = s.object({
    decodeMs: s.optional(s.number({min: 0})),
    analysisLevelMs: s.optional(s.number({min: 0})),
    normalizationMs: s.optional(s.number({min: 0})),
    illuminationPreparationMs: s.optional(s.number({min: 0})),
    layoutNormalizationMs: s.optional(s.number({min: 0})),
    calibrationMs: s.optional(s.number({min: 0})),
    pictureMaskMs: s.optional(s.number({min: 0})),
    modeRecommendationMs: s.optional(s.number({min: 0})),
    qualityNormalizationMs: s.optional(s.number({min: 0})),
    textAxisMs: s.optional(s.number({min: 0})),
    splitMs: s.optional(s.number({min: 0})),
    deskewMs: s.optional(s.number({min: 0})),
    contentMs: s.optional(s.number({min: 0})),
    rasterizationMs: s.optional(s.number({min: 0})),
    maskRasterizationMs: s.optional(s.number({min: 0})),
    binarizationMs: s.optional(s.number({min: 0})),
    thresholdPreparationMs: s.optional(s.number({min: 0})),
    thresholdingMs: s.optional(s.number({min: 0})),
    binaryPostprocessMs: s.optional(s.number({min: 0})),
    mixedCompositionMs: s.optional(s.number({min: 0})),
    outputProcessingMs: s.optional(s.number({min: 0})),
    renderMs: s.optional(s.number({min: 0})),
    writeMs: s.optional(s.number({min: 0})),
}, {
    exact: true,
    message: 'Invalid evb-scan-cleanup stage timings',
});
const outputModeDiagnostics = s.object({
    rule: s.oneOf([
        'blank',
        'color-text-with-pictures',
        'color',
        'text-with-pictures',
        'picture',
        'sparse-text',
        'continuous-tone',
        'confident-text',
        'dense-text',
        'strong-single-line-text',
        'spatial-tone',
        'bilevel-fidelity',
        'uncertain-fallback',
    ] as const, 'Invalid evb-scan-cleanup output mode diagnostics'),
    fallbackUsed: s.boolean(),
    analysisWidth: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    analysisHeight: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    otsuThreshold: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    darkMean: s.number(),
    lightMean: s.number(),
    midtoneLower: s.number(),
    midtoneUpper: s.number(),
    p01: s.number(),
    p50: s.number(),
    p99: s.number(),
    bimodality: s.number(),
    midtoneFraction: s.number(),
    relativeMidtoneFraction: s.number(),
    modeDistance: s.number(),
    inkFraction: s.number(),
    edgeFraction: s.number(),
    robustLuminanceRange: s.number(),
    coloredFraction: s.number(),
    largestColorComponentPixels: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    meanSaturation: s.number(),
    pictureFraction: s.number(),
    textLineCount: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    significantColor: s.boolean(),
    significantPicture: s.boolean(),
    pictureGateMargin: s.number(),
    tonalMidtoneGateMargin: s.number(),
    strongBimodalityGateMargin: s.number(),
    confidentTextBimodalityMargin: s.number(),
    confidentTextModeDistanceMargin: s.number(),
    confidentTextMidtoneMargin: s.number(),
    denseTextLineMargin: s.number(),
    denseTextBimodalityMargin: s.number(),
    denseTextModeDistanceMargin: s.number(),
    denseTextMidtoneMargin: s.number(),
    outsideTonalFraction: s.number(),
    outsideTonalLargestComponentFraction: s.number(),
    outsideTonalLargestComponentWidthFraction: s.number(),
    outsideTonalLargestComponentHeightFraction: s.number(),
    coherentOutsideTonalRegion: s.boolean(),
    destructiveModeTonalVeto: s.boolean(),
    sourceDpi: s.number({min: 0}),
    analysisDpi: s.number({min: 0}),
    calibratedSourceStrokeWidthPx: s.number({min: 0}),
    calibratedSourceXHeightPx: s.number({min: 0}),
    softEdgeToInkRatio: s.number({min: 0}),
    bilevelFidelityVeto: s.boolean(),
}, {
    exact: true,
    message: 'Invalid evb-scan-cleanup output mode diagnostics',
});
const progress = s.refine(s.refine(s.object({
    stage: s.oneOf([
        'started',
        'page-analyzed',
        'page-complete',
        'completed',
    ] as const, 'Invalid evb-scan-cleanup progress envelope'),
    completedPages: nonNegativeInteger('Invalid evb-scan-cleanup progress envelope'),
    totalPages: nonNegativeInteger('Invalid evb-scan-cleanup progress envelope'),
    pageNumber: s.optional(s.number({
        integer: true,
        min: 1,
        message: 'Invalid evb-scan-cleanup progress page number',
    })),
    outputPaths: s.optional(s.array(s.string())),
    classification: s.optional(classification),
    confidence: s.optional(s.number({message: 'Invalid evb-scan-cleanup progress confidence'})),
    cutterXPx: s.optional(s.number({message: 'Invalid evb-scan-cleanup progress cutter'})),
    tier1Verdict: s.optional(classification),
    reconciled: s.optional(s.boolean()),
    clusterAgreement: s.optional(s.number({
        min: -1,
        max: 1,
        message: 'Invalid evb-scan-cleanup cluster agreement',
    })),
    documentPrior: s.optional(documentPrior),
    textAxis: s.optional(textAxis),
    stageTimings: s.optional(pageStageTimings),
    recommendedOutputMode: s.optional(s.oneOf([
        'bw',
        'mixed',
        'grayscale',
        'color',
    ] as const, 'Invalid evb-scan-cleanup recommended output mode')),
    recommendedOutputModeConfidence: s.optional(confidence(
        'Invalid evb-scan-cleanup output mode confidence',
    )),
    recommendedOutputModeReason: s.optional(s.oneOf([
        'blank',
        'color-chroma',
        'text-with-pictures',
        'continuous-tone',
        'bimodal-text',
        'uncertain-tonal',
    ] as const, 'Invalid evb-scan-cleanup output mode recommendation reason')),
    softAlphaForegroundRecommendation: s.optional(s.boolean()),
    outputModeDiagnostics: s.optional(outputModeDiagnostics),
}), value => value.completedPages <= value.totalPages,
'Invalid evb-scan-cleanup progress envelope'), value =>
    value.pageNumber === undefined
        ? value.stage !== 'page-analyzed' && value.stage !== 'page-complete'
        : value.pageNumber <= value.totalPages,
'Invalid evb-scan-cleanup progress page number');
const successResult = s.object({
    status: s.oneOf(['success'] as const),
    completedPages: nonNegativeInteger('Invalid evb-scan-cleanup success result'),
    totalPages: nonNegativeInteger('Invalid evb-scan-cleanup success result'),
});
const failureResult = s.object({
    status: s.oneOf(['failure'] as const),
    code: s.oneOf(NATIVE_ERROR_CODES),
    message: s.string(),
});
const progressEnvelope = s.object({
    version: s.oneOf([SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION] as const),
    type: s.oneOf(['progress'] as const),
    progress,
});
const resultEnvelope = s.object({
    version: s.oneOf([SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION] as const),
    type: s.oneOf(['result'] as const),
    result: s.union([
        successResult,
        failureResult,
    ] as const, 'Invalid evb-scan-cleanup result envelope'),
});

export const NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA = s.fromParser((value: unknown) => {
    if (!isRecord(value) || value.version !== SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION) {
        throw new Error('Unsupported evb-scan-cleanup NDJSON protocol version');
    }
    if (value.type === 'progress') {
        return progressEnvelope.decode(value);
    }
    if (value.type === 'result') {
        return resultEnvelope.decode(value);
    }
    throw new Error('Unknown evb-scan-cleanup NDJSON envelope type');
}, progressEnvelope.example);

export type TNativeScanCleanupPageStageTimingsV3 = TInferSchema<typeof pageStageTimings>;
export type TNativeScanCleanupProgressV3 = TInferSchema<typeof progress>;
export type TNativeScanCleanupProgressStage = TNativeScanCleanupProgressV3['stage'];
export type TNativeScanCleanupProgressEnvelopeV3 = TInferSchema<typeof progressEnvelope>;
export type TNativeScanCleanupResultV3 = TInferSchema<typeof resultEnvelope>['result'];
export type TNativeScanCleanupResultEnvelopeV3 = TInferSchema<typeof resultEnvelope>;
export type TNativeScanCleanupEnvelopeV3 = TInferSchema<typeof NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA>;
