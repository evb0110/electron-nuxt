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
    splitMs: s.optional(s.number({min: 0})),
    deskewMs: s.optional(s.number({min: 0})),
    contentMs: s.optional(s.number({min: 0})),
    renderMs: s.optional(s.number({min: 0})),
    writeMs: s.optional(s.number({min: 0})),
}, {
    exact: true,
    message: 'Invalid evb-scan-cleanup stage timings',
});
const progress = s.refine(s.refine(s.refine(s.object({
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
}), value => value.completedPages <= value.totalPages,
'Invalid evb-scan-cleanup progress envelope'), value =>
    value.pageNumber === undefined
        ? value.stage !== 'page-analyzed' && value.stage !== 'page-complete'
        : value.pageNumber <= value.totalPages,
'Invalid evb-scan-cleanup progress page number'), value =>
    value.stage !== 'page-analyzed' || [
        value.classification,
        value.confidence,
        value.cutterXPx,
        value.tier1Verdict,
        value.reconciled,
        value.clusterAgreement,
        value.documentPrior,
        value.textAxis,
        value.recommendedOutputMode,
        value.recommendedOutputModeConfidence,
        value.recommendedOutputModeReason,
    ].every(item => item === undefined),
'Invalid evb-scan-cleanup pre-reconciliation analysis progress');
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
