import type {
    IScanCleanupMarginsMm,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/geometry';

export type {TScanCleanupPageRotation} from '@contracts/scan-cleanup/geometry';

export type TScanCleanupLayoutMode = 'auto' | 'force-single' | 'force-two-page';
export type TScanCleanupOutputMode = 'bw' | 'mixed' | 'grayscale' | 'color';
export type TScanCleanupBinarizationMethod = 'auto' | 'otsu' | 'sauvola' | 'wolf';
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
    outputMode: TScanCleanupOutputMode;
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
    readingOrder: TScanCleanupReadingOrder;
    skipBlankPages: boolean;
    pageOverrides: TScanCleanupPageOverrides;
}
