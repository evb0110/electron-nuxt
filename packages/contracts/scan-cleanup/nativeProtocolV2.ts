import type {TNativeErrorCode} from '@contracts/nativeErrors';
import type {
    IScanCleanupDocumentPrior,
    IScanCleanupManualZones,
    IScanCleanupTextAxis,
    TScanCleanupCanvasScope,
    TScanCleanupDespeckleLevel,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupPageAlignment,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/domain';
import type {
    IScanCleanupMarginsMm,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
} from '@contracts/scan-cleanup/geometry';

export const SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION = 2 as const;

export type TNativeScanCleanupOperation = 'analyze' | 'render';
export type TNativeScanCleanupRenderMode = 'preview' | 'final';

export interface INativeScanCleanupExperimentalOptionsV2 {autoDewarp: boolean;}

export interface INativeScanCleanupOptionsV2 {
    dpi: number;
    binarization: 'otsu' | 'sauvola' | 'wolf' | 'auto';
    thickness: number;
    normalizeIllumination: boolean;
    despeckle: boolean;
    despeckleLevel?: TScanCleanupDespeckleLevel;
    outputMode: TScanCleanupOutputMode;
    ocrMode: boolean;
    layout: 'auto' | 'force-single' | 'page-with-offcut' | 'keep-left' | 'keep-right' | 'force-two-page';
    manualSplit: IScanCleanupNormalizedSplit | null;
    manualContentBoxes: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
    manualZones?: IScanCleanupManualZones;
    cropContent: boolean;
    matchPageSize: boolean;
    pageAlignment: TScanCleanupPageAlignment;
    placementOverrides: Partial<Record<TScanCleanupOutputHalf, TScanCleanupPageAlignment>>;
    margins: IScanCleanupMarginsMm;
    experimental: INativeScanCleanupExperimentalOptionsV2;
    rotationDegrees: TScanCleanupPageRotation;
    excluded: boolean;
    skipBlankPages: boolean;
    maxPixels: number;
    maxDimensionPx: number;
}

export interface INativeScanCleanupOutputV2 {
    outputPath: string;
    metadataPath: string;
}

export interface INativeScanCleanupPageV2 {
    inputPath: string;
    sourcePageIndex: number;
    pageMetadataPath: string;
    options: INativeScanCleanupOptionsV2;
    outputs: INativeScanCleanupOutputV2[];
    documentPrior?: IScanCleanupDocumentPrior;
}

export interface INativeScanCleanupManifestV2 {
    version: typeof SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION;
    operation: TNativeScanCleanupOperation;
    renderMode: TNativeScanCleanupRenderMode;
    canvasScope: TScanCleanupCanvasScope;
    pages: INativeScanCleanupPageV2[];
}

export type TNativeScanCleanupProgressStage = 'started' | 'page-complete' | 'completed';

export interface INativeScanCleanupProgressV2 {
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
}

export interface INativeScanCleanupProgressEnvelopeV2 {
    version: typeof SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION;
    type: 'progress';
    progress: INativeScanCleanupProgressV2;
}

export type TNativeScanCleanupResultV2 =
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

export interface INativeScanCleanupResultEnvelopeV2 {
    version: typeof SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION;
    type: 'result';
    result: TNativeScanCleanupResultV2;
}

export type TNativeScanCleanupEnvelopeV2 =
    | INativeScanCleanupProgressEnvelopeV2
    | INativeScanCleanupResultEnvelopeV2;
