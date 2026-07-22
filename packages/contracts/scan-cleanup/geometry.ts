export type TScanCleanupPageRotation = 0 | 90 | 180 | 270;

/** A vertical cutter authored in normalized rotated-analysis-page space. */
export interface IScanCleanupNormalizedSplit {
    xNormalized: number;
    rotationDegrees: TScanCleanupPageRotation;
}

/** A half-local rectangle whose axes and scale are the rotated analysis page. */
export interface IScanCleanupNormalizedRect {
    xNormalized: number;
    yNormalized: number;
    widthNormalized: number;
    heightNormalized: number;
    rotationDegrees: TScanCleanupPageRotation;
}

export interface IScanCleanupPixelRect {
    xPx: number;
    yPx: number;
    widthPx: number;
    heightPx: number;
}

export interface IScanCleanupAppliedMargins {
    leftPx: number;
    topPx: number;
    rightPx: number;
    bottomPx: number;
}

export interface IScanCleanupMarginsMm {
    leftMm: number;
    topMm: number;
    rightMm: number;
    bottomMm: number;
}

/** Shared ceiling for every hard-margin editor, codec, and clamp. */
export const SCAN_CLEANUP_MARGIN_MAX_MM = 25;

export interface IScanCleanupPreviewAffine {matrix: number[][];}
