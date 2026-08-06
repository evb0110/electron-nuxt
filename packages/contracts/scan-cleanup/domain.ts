import type {
    IScanCleanupMarginsMm,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/geometry';

export type {TScanCleanupPageRotation} from '@contracts/scan-cleanup/geometry';

export type TScanCleanupLayoutMode = 'auto' | 'force-single' | 'force-two-page';
export type TScanCleanupOutputMode = 'bw' | 'mixed' | 'grayscale' | 'color';
export type TScanCleanupOutputModeRecommendationReason =
    | 'blank'
    | 'color-chroma'
    | 'text-with-pictures'
    | 'continuous-tone'
    | 'bimodal-text'
    | 'uncertain-tonal';
export type TScanCleanupBinarizationMethod = 'auto' | 'otsu' | 'sauvola' | 'wolf';
export type TScanCleanupOutputModeSetting = 'auto' | TScanCleanupOutputMode;
export type TScanCleanupDespeckleLevel = 'off' | 'cautious' | 'normal' | 'aggressive';
export type TScanCleanupReadingOrder = 'ltr' | 'rtl';
export type TScanCleanupPageLayoutOverride = 'auto' | 'single' | 'spread' | 'keep-left' | 'keep-right';
export type TScanCleanupPageAlignment =
    | 'top-left' | 'top-center' | 'top-right'
    | 'center-left' | 'center' | 'center-right'
    | 'bottom-left' | 'bottom-center' | 'bottom-right';
export type TScanCleanupOutputHalf = 'full' | 'left' | 'right';
export type TScanCleanupCanvasScope = 'page' | 'document';
export type TScanCleanupLayoutClassification =
    | 'single-uncut-page'
    | 'page-with-offcut'
    | 'two-page-spread';

/**
 * What the renderer already knows about how each page will be cut, keyed by
 * page number. Matched page size is measured over the pages a run *produces*,
 * so a spread that becomes two half-sheet pages has to be measured as such, and
 * the only place that knows a page is a spread before it is rendered is the
 * detection the user has already watched run. Passing it to the preview and to
 * the run alike is what makes the two agree on one rectangle.
 */
export type TScanCleanupLayoutByPage = Partial<Record<string, TScanCleanupLayoutClassification>>;
export type TScanCleanupPageOutputMapping = Readonly<Record<string, readonly number[]>>;

export const SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES = -15;
export const SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES = 15;
export const SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN = 0.5;
export const SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX = 4;

export interface IScanCleanupClusterDimensions {
    widthPx: number;
    heightPx: number;
}

export interface IScanCleanupDocumentPrior {
    dominantLayout: TScanCleanupLayoutClassification;
    cutterRatioMedian: number | null;
    clusterDims: IScanCleanupClusterDimensions;
    agreementStrength: number;
}

export interface IScanCleanupReconciliationMetadata {
    tier1Verdict: TScanCleanupLayoutClassification;
    reconciled: boolean;
    /** Positive when the page agrees with its cluster, negative when it remains in disagreement. */
    clusterAgreement: number;
}

export interface IScanCleanupTextAxis {
    sideways: boolean;
    confidence: number;
}

export interface IScanCleanupPageOverride {
    rotationDegrees: TScanCleanupPageRotation;
    layoutOverride: TScanCleanupPageLayoutOverride;
    excluded: boolean;
    manualSplit: IScanCleanupNormalizedSplit | null;
    manualSkewDegrees?: number | undefined;
    outputModeOverride?: TScanCleanupOutputMode;
    manualContentBoxes?: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
    manualZones?: IScanCleanupManualZones;
    marginsMm?: IScanCleanupMarginsMm;
    placementOverrides?: Partial<Record<TScanCleanupOutputHalf, TScanCleanupPageAlignment>>;
}

export interface IScanCleanupNormalizedZonePoint {
    xNormalized: number;
    yNormalized: number;
}

/** A polygon authored in normalized rotated-page coordinates. */
export interface IScanCleanupNormalizedZonePolygon {
    points: IScanCleanupNormalizedZonePoint[];
    rotationDegrees: TScanCleanupPageRotation;
}

export type TScanCleanupPictureZoneLayer = 'eraser1' | 'painter2' | 'eraser3';

export interface IScanCleanupPictureZone {
    polygon: IScanCleanupNormalizedZonePolygon;
    layer: TScanCleanupPictureZoneLayer;
}

/** Picture layers apply in eraser1 → painter2 → eraser3 order; fill is binary. */
export interface IScanCleanupManualZones {
    picture: IScanCleanupPictureZone[];
    fill: IScanCleanupNormalizedZonePolygon[];
}

export type TScanCleanupPageOverrides = Record<string, IScanCleanupPageOverride>;

/** Stable renderer/Electron options. Experimental native policy is Electron-internal. */
export interface IScanCleanupOptions {
    preserveOriginalQuality: boolean;
    layoutMode: TScanCleanupLayoutMode;
    outputMode: TScanCleanupOutputModeSetting;
    /** Optional only for bridge compatibility with settings created before advanced output controls. */
    binarization?: TScanCleanupBinarizationMethod;
    /** Optional only for bridge compatibility with settings created before advanced output controls. */
    normalizeIllumination?: boolean;
    thickness: number;
    crop: boolean;
    matchPageSize: boolean;
    pageAlignment: TScanCleanupPageAlignment;
    marginsMm: IScanCleanupMarginsMm;
    /** Canonical speckle-removal setting. Older settings may instead provide `despeckle`. */
    despeckleLevel?: TScanCleanupDespeckleLevel;
    /** @deprecated Read-only compatibility input; `despeckleLevel` is persisted by current clients. */
    despeckle?: boolean;
    /** Experimental automatic page-curvature correction. */
    autoDewarp?: boolean;
    /** Fixed automatic dewarp model depth; absent means automatic depth selection. */
    autoDewarpDepth?: number | undefined;
    readingOrder: TScanCleanupReadingOrder;
    skipBlankPages: boolean;
    pageOverrides: TScanCleanupPageOverrides;
}
