import type {
    IScanCleanupMarginsMm,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/geometry';

export type {TScanCleanupPageRotation} from '@contracts/scan-cleanup/geometry';

export type TScanCleanupLayoutMode = 'auto' | 'force-single' | 'force-two-page';
export type TScanCleanupOutputMode = 'bw' | 'grayscale' | 'color';
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

export interface IScanCleanupPageOverride {
    rotationDegrees: TScanCleanupPageRotation;
    layoutOverride: TScanCleanupPageLayoutOverride;
    excluded: boolean;
    manualSplit: IScanCleanupNormalizedSplit | null;
    manualContentBoxes?: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
    marginsMm?: IScanCleanupMarginsMm;
    placementOverrides?: Partial<Record<TScanCleanupOutputHalf, TScanCleanupPageAlignment>>;
}

export type TScanCleanupPageOverrides = Record<string, IScanCleanupPageOverride>;

/** Stable renderer/Electron options. Experimental native policy is Electron-internal. */
export interface IScanCleanupOptions {
    preserveOriginalQuality: boolean;
    layoutMode: TScanCleanupLayoutMode;
    outputMode: TScanCleanupOutputMode;
    thickness: number;
    crop: boolean;
    matchPageSize: boolean;
    pageAlignment: TScanCleanupPageAlignment;
    marginsMm: IScanCleanupMarginsMm;
    despeckle: boolean;
    readingOrder: TScanCleanupReadingOrder;
    skipBlankPages: boolean;
    pageOverrides: TScanCleanupPageOverrides;
}
