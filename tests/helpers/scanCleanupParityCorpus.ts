import {createHash} from 'node:crypto';
import {
    existsSync,
    readFileSync,
} from 'node:fs';
import {join} from 'node:path';
import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import {
    SCAN_CLEANUP_WARNING_EVENT_CODES,
    type TScanCleanupWarningEvent,
    type TScanCleanupWarningEventCode,
} from '@contracts/scan-cleanup/nativeProtocolV3';

/**
 * SC-IMP-004 Stage A: the one physical unit every fitter observation is
 * normalized into. Native rounds to canvas pixels, the lossless assembler works
 * in PDF points and the preview fitter works on its own pixel grid, so raw
 * pixels and point decimals are never compared with each other — each path is
 * converted into millimetres on the document canvas first.
 */
export const SCAN_CLEANUP_PARITY_UNIT = 'mm';

/**
 * Every corpus fixture carries its scan at this resolution, so the final raster
 * canvas lands on one grid for the whole corpus and a single tolerance is valid
 * for every case. A run that reports a different raster canvas DPI fails
 * loudly instead of silently rescaling the tolerance.
 *
 * It is also the DPI all three paths analyse at — the detection grid, the
 * default request DPI and a scan at this resolution coincide — so a content box
 * measured by one path is the content box measured by the others, and the
 * corpus reports placement disagreements rather than detection-resolution ones.
 */
export const SCAN_CLEANUP_PARITY_CANVAS_DPI = 150;

/** The accepted delta, fixed globally: one raster canvas pixel at the selected canvas DPI. */
export const SCAN_CLEANUP_PARITY_TOLERANCE_RASTER_PIXELS = 1;

export const SCAN_CLEANUP_PARITY_TOLERANCE_MM
    = SCAN_CLEANUP_PARITY_TOLERANCE_RASTER_PIXELS * 25.4 / SCAN_CLEANUP_PARITY_CANVAS_DPI;

export const SCAN_CLEANUP_PARITY_PATHS = [
    'raster-final',
    'lossless-final',
    'preview',
] as const;

export type TScanCleanupParityPath = (typeof SCAN_CLEANUP_PARITY_PATHS)[number];

/** The placement conditions SC-IMP-004 requires the corpus to exercise. */
export const SCAN_CLEANUP_PARITY_REQUIREMENTS = [
    'zero-margins',
    'ordinary-margins',
    'exact-boundary-margins',
    'over-constrained-axes',
    'asymmetric-margins',
    'rotation-0',
    'rotation-90',
    'rotation-180',
    'rotation-270',
    'split-leaves',
    'unequal-crop-spread',
    'canvas-narrower-than-margin-pair',
    'paper-larger-than-canvas',
] as const;

export type TScanCleanupParityRequirement = (typeof SCAN_CLEANUP_PARITY_REQUIREMENTS)[number];

export const SCAN_CLEANUP_PARITY_FIXTURES = [
    'varied-content',
    'rotated',
    'spread',
    'unequal-spread',
    'mixed-orientation',
    'small-canvas-exact',
    'small-canvas-over',
] as const;

export type TScanCleanupParityFixture = (typeof SCAN_CLEANUP_PARITY_FIXTURES)[number];

/** One rectangle of insets, whether requested, fitted or delivered. */
export interface IScanCleanupParityMarginsMm {
    leftMm: number;
    topMm: number;
    rightMm: number;
    bottomMm: number;
}

export interface IScanCleanupParityCase {
    id: string;
    fixture: TScanCleanupParityFixture;
    /** Why this case exists, in placement terms rather than option terms. */
    intent: string;
    marginsMm: IScanCleanupParityMarginsMm;
    layoutMode: NonNullable<IScanCleanupOptions['layoutMode']>;
    pageAlignment: IScanCleanupOptions['pageAlignment'];
    covers: readonly TScanCleanupParityRequirement[];
    /**
     * Paths this case cannot answer on by construction. Declared here rather
     * than discovered by the run, so a path that stops answering for a case
     * that never expected a substitution is a failure and not a footnote.
     */
    expectedPathSubstitutions?: readonly TScanCleanupParityPath[];
}

const uniformMargins = (millimetres: number) => ({
    leftMm: millimetres,
    topMm: millimetres,
    rightMm: millimetres,
    bottomMm: millimetres,
});

/**
 * The product accepts margins of 0-25 mm, so the fitter's `margins fill the
 * canvas` boundary is unreachable on Letter. These two rectangles reach it with
 * a supported request instead: the exact one is 296 canvas pixels wide, which
 * is exactly the pair of 25 mm margins that path rounds to, and the
 * over-constrained one is narrower than that pair on both axes. Both are whole
 * pixel counts at the corpus canvas DPI, so the canvas grid does not round the
 * rectangle onto a different DPI than the tolerance is fixed for.
 */
export const SCAN_CLEANUP_PARITY_EXACT_BOUNDARY_PAGE_POINTS = {
    widthPoints: 142.08,
    heightPoints: 213.12,
};

export const SCAN_CLEANUP_PARITY_OVER_CONSTRAINED_PAGE_POINTS = {
    widthPoints: 113.28,
    heightPoints: 127.68,
};

const SUPPORTED_MAX_MARGIN_MM = 25;

export const SCAN_CLEANUP_PARITY_CASES: readonly IScanCleanupParityCase[] = [
    {
        id: 'zero-margins',
        fixture: 'varied-content',
        intent: 'Content fills the canvas with no inset, so placement alone decides the origin.',
        marginsMm: uniformMargins(0),
        layoutMode: 'force-single',
        pageAlignment: 'top-center',
        covers: [
            'zero-margins',
            'rotation-0',
        ],
    },
    {
        id: 'ordinary-margins',
        fixture: 'varied-content',
        intent: 'The margin a user actually asks for, well inside the canvas.',
        marginsMm: uniformMargins(10),
        layoutMode: 'force-single',
        pageAlignment: 'top-center',
        covers: ['ordinary-margins'],
    },
    {
        id: 'asymmetric-margins',
        fixture: 'varied-content',
        intent: 'Four different insets, so a fitter that averages an axis is visible.',
        marginsMm: {
            leftMm: 5,
            topMm: 20,
            rightMm: 15,
            bottomMm: 8,
        },
        layoutMode: 'force-single',
        pageAlignment: 'top-center',
        covers: ['asymmetric-margins'],
    },
    {
        id: 'exact-boundary-margins',
        fixture: 'small-canvas-exact',
        intent: 'The horizontal margin pair meets the canvas width exactly on the canvas pixel grid.',
        marginsMm: {
            leftMm: SUPPORTED_MAX_MARGIN_MM,
            topMm: 0,
            rightMm: SUPPORTED_MAX_MARGIN_MM,
            bottomMm: 0,
        },
        layoutMode: 'force-single',
        pageAlignment: 'top-center',
        covers: ['exact-boundary-margins'],
    },
    {
        id: 'over-constrained-axes',
        fixture: 'small-canvas-over',
        intent: 'Both axes ask for more margin than the canvas holds.',
        marginsMm: {
            leftMm: SUPPORTED_MAX_MARGIN_MM,
            topMm: SUPPORTED_MAX_MARGIN_MM,
            rightMm: SUPPORTED_MAX_MARGIN_MM,
            bottomMm: SUPPORTED_MAX_MARGIN_MM,
        },
        layoutMode: 'force-single',
        pageAlignment: 'top-center',
        covers: ['over-constrained-axes'],
    },
    {
        id: 'canvas-narrower-than-margin-pair',
        fixture: 'small-canvas-over',
        intent: 'The horizontal pair alone is wider than the canvas while the vertical pair fits.',
        marginsMm: {
            leftMm: SUPPORTED_MAX_MARGIN_MM,
            topMm: 5,
            rightMm: SUPPORTED_MAX_MARGIN_MM,
            bottomMm: 5,
        },
        layoutMode: 'force-single',
        pageAlignment: 'top-center',
        covers: ['canvas-narrower-than-margin-pair'],
    },
    {
        id: 'rotated-pages',
        fixture: 'rotated',
        intent: 'One document whose four pages present the same rectangle through four source rotations.',
        marginsMm: uniformMargins(10),
        layoutMode: 'force-single',
        pageAlignment: 'top-center',
        covers: [
            'rotation-0',
            'rotation-90',
            'rotation-180',
            'rotation-270',
        ],
    },
    {
        id: 'split-leaves',
        fixture: 'spread',
        intent: 'Both leaves of a cut spread land on the shared half-sheet canvas.',
        marginsMm: uniformMargins(10),
        layoutMode: 'force-two-page',
        pageAlignment: 'top-center',
        covers: ['split-leaves'],
    },
    {
        id: 'unequal-crop-spread',
        fixture: 'unequal-spread',
        intent: 'A spread whose leaves crop to different ink extents shares one placement decision.',
        marginsMm: uniformMargins(10),
        layoutMode: 'force-two-page',
        pageAlignment: 'top-center',
        covers: ['unequal-crop-spread'],
    },
    {
        id: 'paper-larger-than-canvas',
        fixture: 'mixed-orientation',
        intent: 'A portrait sheet placed on a landscape canvas of equal area is larger than the canvas it must fit.',
        marginsMm: uniformMargins(10),
        layoutMode: 'force-single',
        pageAlignment: 'top-center',
        covers: ['paper-larger-than-canvas'],
        // Paper this canvas cannot hold losslessly is exactly what makes the
        // matched-canvas policy re-render the page, and a re-rendered document
        // never reaches the lossless assembler. The condition the case exists
        // to exercise is the condition that removes the third path from it, so
        // the substitution is declared with the case rather than discovered.
        expectedPathSubstitutions: ['lossless-final'],
    },
];

export function resolveScanCleanupParityCoverageGaps(
    cases: readonly IScanCleanupParityCase[] = SCAN_CLEANUP_PARITY_CASES,
) {
    const covered = new Set(cases.flatMap(parityCase => parityCase.covers));
    return SCAN_CLEANUP_PARITY_REQUIREMENTS.filter(requirement => !covered.has(requirement));
}

export function millimetresFromPoints(points: number) {
    return points / 72 * 25.4;
}

export function millimetresFromPixels(pixels: number, dpi: number) {
    return pixels / dpi * 25.4;
}

function failObservation(detail: string): never {
    throw new Error(`Invalid scan-cleanup parity observation: ${detail}`);
}

/**
 * Every number an observation is built from is checked before it is converted,
 * because millimetres derived from a NaN, an infinity or a zero-sized canvas
 * are still numbers: they would travel into the report, into a scale ratio and
 * into an alignment code, and only a delta somewhere downstream would hint that
 * the geometry was never measured. A path that reports geometry it does not
 * have fails here instead.
 */
function requireFiniteMeasurement(value: number, label: string) {
    if (!Number.isFinite(value)) failObservation(`${label} must be a finite number`);
    return value;
}

function requirePositiveMeasurement(value: number, label: string) {
    if (!Number.isFinite(value) || value <= 0) failObservation(`${label} must be a positive finite number`);
    return value;
}

/** A content box may be empty where a page carries no ink; it cannot be negative. */
function requireNonNegativeMeasurement(value: number, label: string) {
    if (!Number.isFinite(value) || value < 0) failObservation(`${label} must be a non-negative finite number`);
    return value;
}

/**
 * Checking the numbers that go into a conversion does not make the number that
 * comes out of it a measurement: two finite values near the top of the range
 * add or subtract past it, a pixel count divided by a small enough grid leaves
 * it, and a box divided by a canvas that survived as a denormal does too. Each
 * of those returns an infinity, which is as unusable downstream as the NaN the
 * input checks refuse. So every derived number is checked again where it is
 * computed, and a path whose arithmetic left the range fails here rather than
 * publishing an infinite millimetre.
 */
function requireFiniteDerivations<T extends Record<string, number>>(where: string, values: T) {
    for (const [
        label,
        value,
    ] of Object.entries(values)) requireFiniteMeasurement(value, `${where} ${label}`);
    return values;
}

export interface IScanCleanupParityRectMm {
    xMm: number;
    yMm: number;
    widthMm: number;
    heightMm: number;
}

export type TScanCleanupParityAlignmentPosition = 'start' | 'center' | 'end' | 'custom';

export type TScanCleanupParityCanvasGrid = 'raster-canvas' | 'preview-raster' | 'lossless-points';

export type TScanCleanupParityHalf = 'full' | 'left' | 'right';

export interface IScanCleanupParityObservation {
    caseId: string;
    path: TScanCleanupParityPath;
    sourcePageNumber: number;
    outputOrdinal: number;
    half: TScanCleanupParityHalf;
    /** Quarter turns the source page itself carries. */
    sourceRotationDegrees: number;
    /** Quarter turns scan cleanup was asked to add on top of the source's. */
    rotationDegrees: number;
    unit: typeof SCAN_CLEANUP_PARITY_UNIT;
    toleranceMm: number;
    sourceDpi: number | null;
    canvasDpi: number;
    canvasGrid: TScanCleanupParityCanvasGrid;
    requestedMarginsMm: IScanCleanupParityMarginsMm;
    /** What the path itself reports after fitting the request, when it publishes that. */
    fittedRequestedMarginsMm: IScanCleanupParityMarginsMm | null;
    /** What the placed content actually leaves at each canvas edge. */
    deliveredMarginsMm: IScanCleanupParityMarginsMm;
    canvasRectMm: {
        widthMm: number;
        heightMm: number;
    };
    /** Content box on the canvas, top-left origin, in the declared unit. */
    contentRectMm: IScanCleanupParityRectMm;
    contentScaleOfCanvas: {
        width: number;
        height: number;
    };
    placementOffsetMm: {
        xMm: number;
        yMm: number;
    };
    requestedAlignment: IScanCleanupOptions['pageAlignment'];
    deliveredAlignment: {
        horizontal: TScanCleanupParityAlignmentPosition;
        vertical: TScanCleanupParityAlignmentPosition;
    };
    /** Typed SC-IMP-003 events, or null when this path publishes no typed channel. */
    warningEvents: TScanCleanupWarningEvent[] | null;
    warningMessages: string[];
}

function resolveAlignmentPosition(
    offsetMm: number,
    freeMm: number,
    toleranceMm: number,
): TScanCleanupParityAlignmentPosition {
    // Order matters where free space is smaller than the tolerance: such a
    // placement is every position at once, and reporting it as the leading
    // edge keeps two paths that both filled the axis from disagreeing.
    if (Math.abs(offsetMm) <= toleranceMm) {
        return 'start';
    }
    if (Math.abs(freeMm - offsetMm) <= toleranceMm) {
        return 'end';
    }
    if (Math.abs(offsetMm - (freeMm / 2)) <= toleranceMm) {
        return 'center';
    }
    return 'custom';
}

function insetsFromPixels(insets: {
    leftPx: number;
    topPx: number;
    rightPx: number;
    bottomPx: number;
}, dpi: number) {
    return {
        leftMm: millimetresFromPixels(insets.leftPx, dpi),
        topMm: millimetresFromPixels(insets.topPx, dpi),
        rightMm: millimetresFromPixels(insets.rightPx, dpi),
        bottomMm: millimetresFromPixels(insets.bottomPx, dpi),
    };
}

/**
 * Once a path has stated its canvas, its content box and its offset in
 * millimetres, nothing about the observation depends on whether those numbers
 * arrived as pixels or as points. The delivered margins, the scale, the
 * alignment codes and the tolerance are derived here for every path, so two
 * grids cannot disagree because one of them derived a field differently.
 */
function buildScanCleanupParityObservation(source: {
    caseId: string;
    path: TScanCleanupParityPath;
    canvasGrid: TScanCleanupParityCanvasGrid;
    sourcePageNumber: number;
    outputOrdinal: number;
    half: TScanCleanupParityHalf;
    sourceRotationDegrees: number;
    rotationDegrees: number;
    sourceDpi: number | null;
    canvasDpi: number;
    requestedMarginsMm: IScanCleanupParityMarginsMm;
    requestedAlignment: IScanCleanupOptions['pageAlignment'];
    fittedRequestedMarginsMm: IScanCleanupParityMarginsMm | null;
    canvasWidthMm: number;
    canvasHeightMm: number;
    contentWidthMm: number;
    contentHeightMm: number;
    offsetXMm: number;
    offsetYMm: number;
    warningEvents: TScanCleanupWarningEvent[] | null;
    warningMessages: readonly string[];
}): IScanCleanupParityObservation {
    const {
        canvasWidthMm,
        canvasHeightMm,
        contentWidthMm,
        contentHeightMm,
        offsetXMm,
        offsetYMm,
    } = source;
    const where = `${source.path} ${source.caseId} page ${String(source.sourcePageNumber)} ${source.half}`;
    requirePositiveMeasurement(canvasWidthMm, `${where} canvas widthMm`);
    requirePositiveMeasurement(canvasHeightMm, `${where} canvas heightMm`);
    requireNonNegativeMeasurement(contentWidthMm, `${where} content widthMm`);
    requireNonNegativeMeasurement(contentHeightMm, `${where} content heightMm`);
    const deliveredMarginsMm = {
        leftMm: offsetXMm,
        topMm: offsetYMm,
        rightMm: canvasWidthMm - offsetXMm - contentWidthMm,
        bottomMm: canvasHeightMm - offsetYMm - contentHeightMm,
    };
    const contentScaleOfCanvas = {
        width: contentWidthMm / canvasWidthMm,
        height: contentHeightMm / canvasHeightMm,
    };
    requireFiniteDerivations(where, {
        'offset xMm': offsetXMm,
        'offset yMm': offsetYMm,
        'delivered rightMm': deliveredMarginsMm.rightMm,
        'delivered bottomMm': deliveredMarginsMm.bottomMm,
        'content width scale': contentScaleOfCanvas.width,
        'content height scale': contentScaleOfCanvas.height,
    });
    return {
        caseId: source.caseId,
        path: source.path,
        sourcePageNumber: source.sourcePageNumber,
        outputOrdinal: source.outputOrdinal,
        half: source.half,
        sourceRotationDegrees: source.sourceRotationDegrees,
        rotationDegrees: source.rotationDegrees,
        unit: SCAN_CLEANUP_PARITY_UNIT,
        toleranceMm: SCAN_CLEANUP_PARITY_TOLERANCE_MM,
        sourceDpi: source.sourceDpi,
        canvasDpi: source.canvasDpi,
        canvasGrid: source.canvasGrid,
        requestedMarginsMm: source.requestedMarginsMm,
        fittedRequestedMarginsMm: source.fittedRequestedMarginsMm,
        deliveredMarginsMm,
        canvasRectMm: {
            widthMm: canvasWidthMm,
            heightMm: canvasHeightMm,
        },
        contentRectMm: {
            xMm: offsetXMm,
            yMm: offsetYMm,
            widthMm: contentWidthMm,
            heightMm: contentHeightMm,
        },
        contentScaleOfCanvas,
        placementOffsetMm: {
            xMm: offsetXMm,
            yMm: offsetYMm,
        },
        requestedAlignment: source.requestedAlignment,
        deliveredAlignment: {
            horizontal: resolveAlignmentPosition(
                offsetXMm,
                canvasWidthMm - contentWidthMm,
                SCAN_CLEANUP_PARITY_TOLERANCE_MM,
            ),
            vertical: resolveAlignmentPosition(
                offsetYMm,
                canvasHeightMm - contentHeightMm,
                SCAN_CLEANUP_PARITY_TOLERANCE_MM,
            ),
        },
        warningEvents: source.warningEvents === null ? null : [...source.warningEvents],
        warningMessages: [...source.warningMessages],
    };
}

export interface IScanCleanupParityCanvasPixelSource {
    caseId: string;
    path: TScanCleanupParityPath;
    canvasGrid: TScanCleanupParityCanvasGrid;
    sourcePageNumber: number;
    outputOrdinal: number;
    sourceRotationDegrees: number;
    requestedMarginsMm: IScanCleanupParityMarginsMm;
    requestedAlignment: IScanCleanupOptions['pageAlignment'];
    metadata: {
        half?: TScanCleanupParityHalf;
        rotationDegrees?: number;
        sourceDpi?: number | null;
        canvasWidthPx: number;
        canvasHeightPx: number;
        matchedCanvasTargetWidthPoints?: number | null;
        matchedCanvasTargetHeightPoints?: number | null;
        matchedCanvasContentWidthPx?: number | null;
        matchedCanvasContentHeightPx?: number | null;
        outputWidthPx: number;
        outputHeightPx: number;
        placementOffsetXPx: number;
        placementOffsetYPx: number;
        appliedMargins?: {
            leftPx: number;
            topPx: number;
            rightPx: number;
            bottomPx: number;
        };
        warningEvents?: readonly TScanCleanupWarningEvent[];
        warnings?: readonly string[];
    };
    /**
     * False only where the run could not reach the path's typed events at all.
     * Such a path is recorded as a declared limitation of the report rather
     * than compared on warning codes it never published.
     */
    publishesTypedWarningEvents: boolean;
}

/**
 * The raster final and preview paths both describe placement on a pixel canvas
 * whose physical rectangle they publish, so one normalization owns both.
 */
export function normalizeScanCleanupParityCanvasPixelObservation(
    source: IScanCleanupParityCanvasPixelSource,
): IScanCleanupParityObservation {
    const {metadata} = source;
    const canvasWidthPoints = metadata.matchedCanvasTargetWidthPoints ?? null;
    const canvasHeightPoints = metadata.matchedCanvasTargetHeightPoints ?? null;
    if (canvasWidthPoints === null || canvasHeightPoints === null) {
        throw new Error(
            `${source.path} ${source.caseId} page ${String(source.sourcePageNumber)} published no matched canvas rectangle`,
        );
    }
    const where = `${source.path} ${source.caseId} page ${String(source.sourcePageNumber)}`;
    requirePositiveMeasurement(canvasWidthPoints, `${where} matched canvas widthPoints`);
    requirePositiveMeasurement(canvasHeightPoints, `${where} matched canvas heightPoints`);
    requirePositiveMeasurement(metadata.canvasWidthPx, `${where} canvasWidthPx`);
    requirePositiveMeasurement(metadata.canvasHeightPx, `${where} canvasHeightPx`);
    const canvasDpi = metadata.canvasWidthPx / canvasWidthPoints * 72;
    // A pixel count and a point count that are each measurements still divide
    // into a grid that is not one: the ratio leaves the range where the canvas
    // is enormous across a hair of paper, and returns zero where it is not.
    // Every millimetre below is divided by this number, so an unusable one has
    // to stop here rather than convert the whole observation to zero.
    requirePositiveMeasurement(canvasDpi, `${where} canvas DPI`);
    // The canvas is one square-pixel grid or it is not a grid this corpus can
    // convert: every millimetre below comes from the DPI the width axis
    // implies, so a height axis that implies a different one would silently
    // rescale half of the observation. Each axis may round its own pixel count,
    // so the two are allowed to disagree by the DPI one pixel of that axis is
    // worth and no more.
    const canvasHeightDpi = metadata.canvasHeightPx / canvasHeightPoints * 72;
    const gridDpiSlack = 72 * ((1 / canvasWidthPoints) + (1 / canvasHeightPoints));
    if (Math.abs(canvasDpi - canvasHeightDpi) > gridDpiSlack) {
        failObservation(
            `${where} canvas is ${canvasDpi.toString()} DPI across and ${canvasHeightDpi.toString()} DPI down`,
        );
    }
    const contentWidthPx = requireNonNegativeMeasurement(
        metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx,
        `${where} content widthPx`,
    );
    const contentHeightPx = requireNonNegativeMeasurement(
        metadata.matchedCanvasContentHeightPx ?? metadata.outputHeightPx,
        `${where} content heightPx`,
    );
    requireFiniteMeasurement(metadata.placementOffsetXPx, `${where} placementOffsetXPx`);
    requireFiniteMeasurement(metadata.placementOffsetYPx, `${where} placementOffsetYPx`);
    const fittedRequestedMarginsMm = metadata.appliedMargins === undefined
        ? null
        : requireFiniteDerivations(
            `${where} fitted margins`,
            insetsFromPixels(metadata.appliedMargins, canvasDpi),
        );
    return buildScanCleanupParityObservation({
        caseId: source.caseId,
        path: source.path,
        canvasGrid: source.canvasGrid,
        sourcePageNumber: source.sourcePageNumber,
        outputOrdinal: source.outputOrdinal,
        half: metadata.half ?? 'full',
        sourceRotationDegrees: source.sourceRotationDegrees,
        rotationDegrees: metadata.rotationDegrees ?? 0,
        sourceDpi: metadata.sourceDpi ?? null,
        canvasDpi,
        requestedMarginsMm: source.requestedMarginsMm,
        requestedAlignment: source.requestedAlignment,
        fittedRequestedMarginsMm,
        canvasWidthMm: millimetresFromPoints(canvasWidthPoints),
        canvasHeightMm: millimetresFromPoints(canvasHeightPoints),
        contentWidthMm: millimetresFromPixels(contentWidthPx, canvasDpi),
        contentHeightMm: millimetresFromPixels(contentHeightPx, canvasDpi),
        offsetXMm: millimetresFromPixels(metadata.placementOffsetXPx, canvasDpi),
        offsetYMm: millimetresFromPixels(metadata.placementOffsetYPx, canvasDpi),
        warningEvents: source.publishesTypedWarningEvents ? [...metadata.warningEvents ?? []] : null,
        warningMessages: metadata.warnings ?? [],
    });
}

export interface IScanCleanupParityPointsSource {
    caseId: string;
    sourcePageNumber: number;
    outputOrdinal: number;
    half: TScanCleanupParityHalf;
    sourceRotationDegrees: number;
    rotationDegrees: number;
    sourceDpi: number | null;
    canvasDpi: number;
    requestedMarginsMm: IScanCleanupParityMarginsMm;
    requestedAlignment: IScanCleanupOptions['pageAlignment'];
    /** Canvas rectangle as the reader sees it, in PDF points. */
    canvasPoints: {
        widthPoints: number;
        heightPoints: number;
    };
    /**
     * Delivered content box on that canvas in PDF points, top-left origin, in
     * the same presented orientation as the canvas. The assembler works in the
     * page's own unrotated user space, so a quarter-turned page has to be
     * mapped into presented space before it is comparable with a raster canvas.
     */
    contentPoints: {
        xPoints: number;
        yTopPoints: number;
        widthPoints: number;
        heightPoints: number;
    };
    /** Typed events when the run could capture them, null when it could not. */
    warningEvents: TScanCleanupWarningEvent[] | null;
    warningMessages: readonly string[];
}

/**
 * The lossless assembler never rasterizes: it publishes the canvas box and the
 * placed content in PDF points, so the same physical answer is reached without
 * inventing a pixel grid for it.
 */
export function normalizeScanCleanupParityPointsObservation(
    source: IScanCleanupParityPointsSource,
): IScanCleanupParityObservation {
    const where = `lossless-final ${source.caseId} page ${String(source.sourcePageNumber)} ${source.half}`;
    requirePositiveMeasurement(source.canvasPoints.widthPoints, `${where} canvas widthPoints`);
    requirePositiveMeasurement(source.canvasPoints.heightPoints, `${where} canvas heightPoints`);
    requireNonNegativeMeasurement(source.contentPoints.widthPoints, `${where} content widthPoints`);
    requireNonNegativeMeasurement(source.contentPoints.heightPoints, `${where} content heightPoints`);
    // A content box may sit outside the canvas — paper this canvas cannot hold
    // is one of the conditions the corpus exercises — so the offsets are only
    // required to be measurements at all.
    requireFiniteMeasurement(source.contentPoints.xPoints, `${where} content xPoints`);
    requireFiniteMeasurement(source.contentPoints.yTopPoints, `${where} content yTopPoints`);
    // This path publishes points rather than pixels, so the declared grid is
    // carried into the report rather than divided into the geometry. It is
    // held to being a grid at all; how much paper it resolves is not this
    // path's claim, and a canvas too small for the arithmetic to survive is
    // caught where the derived millimetres are checked.
    requirePositiveMeasurement(source.canvasDpi, `${where} canvasDpi`);
    return buildScanCleanupParityObservation({
        caseId: source.caseId,
        path: 'lossless-final',
        canvasGrid: 'lossless-points',
        sourcePageNumber: source.sourcePageNumber,
        outputOrdinal: source.outputOrdinal,
        half: source.half,
        sourceRotationDegrees: source.sourceRotationDegrees,
        rotationDegrees: source.rotationDegrees,
        sourceDpi: source.sourceDpi,
        canvasDpi: source.canvasDpi,
        requestedMarginsMm: source.requestedMarginsMm,
        requestedAlignment: source.requestedAlignment,
        fittedRequestedMarginsMm: null,
        canvasWidthMm: millimetresFromPoints(source.canvasPoints.widthPoints),
        canvasHeightMm: millimetresFromPoints(source.canvasPoints.heightPoints),
        contentWidthMm: millimetresFromPoints(source.contentPoints.widthPoints),
        contentHeightMm: millimetresFromPoints(source.contentPoints.heightPoints),
        offsetXMm: millimetresFromPoints(source.contentPoints.xPoints),
        offsetYMm: millimetresFromPoints(source.contentPoints.yTopPoints),
        warningEvents: source.warningEvents,
        warningMessages: source.warningMessages,
    });
}

export interface IScanCleanupParityPageSpaceRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IScanCleanupParityAnalysisRectPx {
    xPx: number;
    yPx: number;
    widthPx: number;
    heightPx: number;
}

/**
 * A source page as the document declares it: its box in PDF user space and the
 * quarter turn a reader applies to it. Only the fields the projection needs are
 * named, so this stays a statement of geometry rather than a borrowed type.
 */
export interface IScanCleanupParityPdfPageBox {
    xPoints: number;
    yPoints: number;
    widthPoints: number;
    heightPoints: number;
    rotation: number;
}

function quarterTurnsOf(degrees: number, label: string) {
    requireFiniteMeasurement(degrees, label);
    if (degrees % 90 !== 0) failObservation(`${label} must be a quarter turn, not ${String(degrees)} degrees`);
    return ((degrees / 90 % 4) + 4) % 4;
}

/**
 * One quarter turn anticlockwise of a point of the unit square, where u runs
 * right and v runs down. A clockwise turn sends the top-left corner to the
 * top-right, so its inverse sends (u, v) to (v, 1 - u).
 */
function turnUnitSquarePointBack(point: {
    u: number;
    v: number;
}, turns: number) {
    let {
        u,
        v,
    } = point;
    for (let turn = 0; turn < turns; turn += 1) {
        const previousU = u;
        u = v;
        v = 1 - previousU;
    }
    return {
        u,
        v,
    };
}

/**
 * Where a rectangle the sidecar measured on a rendered page lands in that
 * page's own PDF user space — derived here, from the page geometry the document
 * declares, so that this corpus can disagree with the assembler.
 *
 * The derivation is stated once in normalized coordinates rather than
 * per-rotation. Two rotations sit between the measurement and the page: the
 * quarter turn scan cleanup applied before analysing, and the quarter turn the
 * document asks a reader to apply. Both are clockwise turns of the same unit
 * square, so undoing them is one anticlockwise turn of `cleanup + page`, after
 * which u and v are fractions of the page's own unrotated box. PDF user space
 * has its origin at the bottom-left of that box, so v — which runs down from
 * the top — is subtracted from one, and the box's own origin is added last:
 * a crop box that does not start at zero moves the whole projection with it.
 *
 * `displayWidthPx` and `displayHeightPx` are the rendered page before scan
 * cleanup's own turn, which is why an odd cleanup turn measures the rectangle
 * against them swapped.
 */
export function mapScanCleanupParityAnalysisRectToPdfPoints(
    rect: IScanCleanupParityAnalysisRectPx,
    displayWidthPx: number,
    displayHeightPx: number,
    cleanupRotationDegrees: number,
    page: IScanCleanupParityPdfPageBox,
): IScanCleanupParityPageSpaceRect {
    requirePositiveMeasurement(displayWidthPx, 'analysis displayWidthPx');
    requirePositiveMeasurement(displayHeightPx, 'analysis displayHeightPx');
    requireFiniteMeasurement(rect.xPx, 'analysis rect xPx');
    requireFiniteMeasurement(rect.yPx, 'analysis rect yPx');
    requireNonNegativeMeasurement(rect.widthPx, 'analysis rect widthPx');
    requireNonNegativeMeasurement(rect.heightPx, 'analysis rect heightPx');
    requireFiniteMeasurement(page.xPoints, 'page xPoints');
    requireFiniteMeasurement(page.yPoints, 'page yPoints');
    requirePositiveMeasurement(page.widthPoints, 'page widthPoints');
    requirePositiveMeasurement(page.heightPoints, 'page heightPoints');
    const cleanupTurns = quarterTurnsOf(cleanupRotationDegrees, 'cleanup rotation');
    const pageTurns = quarterTurnsOf(page.rotation, 'page rotation');
    const analysisWidthPx = cleanupTurns % 2 === 0 ? displayWidthPx : displayHeightPx;
    const analysisHeightPx = cleanupTurns % 2 === 0 ? displayHeightPx : displayWidthPx;
    const corners = [
        {
            u: rect.xPx / analysisWidthPx,
            v: rect.yPx / analysisHeightPx,
        },
        {
            u: (rect.xPx + rect.widthPx) / analysisWidthPx,
            v: (rect.yPx + rect.heightPx) / analysisHeightPx,
        },
    ].map(corner => turnUnitSquarePointBack(corner, (cleanupTurns + pageTurns) % 4));
    const leftFraction = Math.min(...corners.map(corner => corner.u));
    const rightFraction = Math.max(...corners.map(corner => corner.u));
    const topFraction = Math.min(...corners.map(corner => corner.v));
    const bottomFraction = Math.max(...corners.map(corner => corner.v));
    // A rectangle measured far outside the render, or a page box stated near
    // the top of the range, turns into a fraction and back through additions,
    // subtractions and multiplications that can each leave the range even
    // though every input was a measurement. Nothing an infinity or a NaN
    // touches recovers, so the projection is proved to be a rectangle here
    // rather than handed to a caller that would compare it in millimetres.
    return requireFiniteDerivations('analysis rect projection', {
        x: page.xPoints + (leftFraction * page.widthPoints),
        y: page.yPoints + ((1 - bottomFraction) * page.heightPoints),
        width: (rightFraction - leftFraction) * page.widthPoints,
        height: (bottomFraction - topFraction) * page.heightPoints,
    });
}

/**
 * Maps a canvas box and the content placed on it from the page's own unrotated
 * PDF user space, where the split assembler writes them, into the orientation
 * the reader sees, with a top-left origin. Comparing the assembler's page-space
 * rectangle with a raster canvas directly would report a quarter-turned page as
 * a placement disagreement.
 */
export function presentScanCleanupParityPageSpaceRect(
    canvas: {
        width: number;
        height: number;
    },
    content: IScanCleanupParityPageSpaceRect,
    displayRotationDegrees: number,
) {
    const quarterTurns = ((Math.round(displayRotationDegrees / 90) % 4) + 4) % 4;
    const xTop = content.x;
    const yTop = canvas.height - content.y - content.height;
    if (quarterTurns === 1) {
        return {
            canvasPoints: {
                widthPoints: canvas.height,
                heightPoints: canvas.width,
            },
            contentPoints: {
                xPoints: canvas.height - yTop - content.height,
                yTopPoints: xTop,
                widthPoints: content.height,
                heightPoints: content.width,
            },
        };
    }
    if (quarterTurns === 2) {
        return {
            canvasPoints: {
                widthPoints: canvas.width,
                heightPoints: canvas.height,
            },
            contentPoints: {
                xPoints: canvas.width - xTop - content.width,
                yTopPoints: canvas.height - yTop - content.height,
                widthPoints: content.width,
                heightPoints: content.height,
            },
        };
    }
    if (quarterTurns === 3) {
        return {
            canvasPoints: {
                widthPoints: canvas.height,
                heightPoints: canvas.width,
            },
            contentPoints: {
                xPoints: yTop,
                yTopPoints: canvas.width - xTop - content.width,
                widthPoints: content.height,
                heightPoints: content.width,
            },
        };
    }
    return {
        canvasPoints: {
            widthPoints: canvas.width,
            heightPoints: canvas.height,
        },
        contentPoints: {
            xPoints: xTop,
            yTopPoints: yTop,
            widthPoints: content.width,
            heightPoints: content.height,
        },
    };
}

export interface IScanCleanupParityDelta {
    caseId: string;
    sourcePageNumber: number;
    half: TScanCleanupParityHalf;
    field: string;
    unit: 'mm' | 'ratio' | 'code';
    left: {
        path: TScanCleanupParityPath;
        value: number | string;
    };
    right: {
        path: TScanCleanupParityPath;
        value: number | string;
    };
    delta: number;
    toleranceMm: number;
    tolerance: number;
    withinTolerance: boolean;
}

export interface IScanCleanupParityComparison {
    caseId: string;
    sourcePageNumber: number;
    half: TScanCleanupParityHalf;
    paths: TScanCleanupParityPath[];
    missingPaths: TScanCleanupParityPath[];
    deltas: IScanCleanupParityDelta[];
}

const MM_FIELDS: ReadonlyArray<{
    field: string;
    read: (observation: IScanCleanupParityObservation) => number;
}> = [
    {
        field: 'deliveredMarginsMm.leftMm',
        read: observation => observation.deliveredMarginsMm.leftMm,
    },
    {
        field: 'deliveredMarginsMm.topMm',
        read: observation => observation.deliveredMarginsMm.topMm,
    },
    {
        field: 'deliveredMarginsMm.rightMm',
        read: observation => observation.deliveredMarginsMm.rightMm,
    },
    {
        field: 'deliveredMarginsMm.bottomMm',
        read: observation => observation.deliveredMarginsMm.bottomMm,
    },
    {
        field: 'canvasRectMm.widthMm',
        read: observation => observation.canvasRectMm.widthMm,
    },
    {
        field: 'canvasRectMm.heightMm',
        read: observation => observation.canvasRectMm.heightMm,
    },
    {
        field: 'contentRectMm.widthMm',
        read: observation => observation.contentRectMm.widthMm,
    },
    {
        field: 'contentRectMm.heightMm',
        read: observation => observation.contentRectMm.heightMm,
    },
    {
        field: 'placementOffsetMm.xMm',
        read: observation => observation.placementOffsetMm.xMm,
    },
    {
        field: 'placementOffsetMm.yMm',
        read: observation => observation.placementOffsetMm.yMm,
    },
];

const RATIO_FIELDS: ReadonlyArray<{
    field: string;
    read: (observation: IScanCleanupParityObservation) => number;
    span: (observation: IScanCleanupParityObservation) => number;
}> = [
    {
        field: 'contentScaleOfCanvas.width',
        read: observation => observation.contentScaleOfCanvas.width,
        span: observation => observation.canvasRectMm.widthMm,
    },
    {
        field: 'contentScaleOfCanvas.height',
        read: observation => observation.contentScaleOfCanvas.height,
        span: observation => observation.canvasRectMm.heightMm,
    },
];

/**
 * Unit conversion leaves a delta of exactly one canvas pixel a few float ulps
 * above the tolerance computed from the same pixel. A nanometre of slack keeps
 * that arithmetic artifact from being reported as a placement disagreement; it
 * is far below anything either fitter can express.
 */
const FLOAT_SLACK_MM = 1e-9;

function withinTolerance(delta: number, tolerance: number) {
    return delta <= tolerance + FLOAT_SLACK_MM;
}

function observationKey(observation: IScanCleanupParityObservation) {
    return `${observation.caseId}:${String(observation.sourcePageNumber)}:${observation.half}`;
}

function stableEventJson(event: TScanCleanupWarningEvent) {
    return JSON.stringify(Object.fromEntries(
        Object.entries(event as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
    ));
}

export type TScanCleanupParityWarningComparison = 'code-only' | 'code-and-params';

/**
 * How each SC-IMP-003 condition is compared across the three fitters, decided
 * per code rather than inferred from the shape of a payload.
 *
 * `code-only` is for the conditions whose every numeric parameter is stated on
 * the producer's own grid — canvas pixels for a raster fitter, PDF points for
 * the lossless one, the render DPI each path chose for itself. This corpus
 * never compares those decimals across paths; the physical placement fields
 * above already do that in millimetres, so comparing them here would report the
 * grid rather than the placement. The page a condition belongs to is the
 * comparison key, so a per-page code loses nothing by dropping its own copy.
 *
 * `code-and-params` is everything else: parameters that describe the document
 * itself — which pages a condition names, what a producer could not measure —
 * mean the same thing on every path, so a disagreement about them is a real
 * disagreement and stays in the signature.
 *
 * The record is exhaustive over the contract's codes, so a code added to
 * SC-IMP-003 without a decision here fails to compile; a code that reaches the
 * signature without one fails at the first event. Every parameter, compared or
 * not, is recorded on the observation either way.
 */
export const SCAN_CLEANUP_PARITY_WARNING_COMPARISON_POLICY: Readonly<
    Record<TScanCleanupWarningEventCode, TScanCleanupParityWarningComparison>
> = {
    // unit + contentWidth/Height + innerWidth/Height + documentCanvasWidth/Height.
    'matched-canvas-content-fitted': 'code-only',
    // unit + scalePercentTenths + documentCanvasWidth/Height + paperWidth/Height.
    'matched-canvas-paper-downscaled': 'code-only',
    // leftPx/rightPx: the producing fitter's own canvas pixels.
    'matched-canvas-intrinsic-overflow': 'code-only',
    // topPx: the producing fitter's own canvas pixels.
    'matched-canvas-spread-headroom-trimmed': 'code-only',
    // leftColumns/rightColumns: columns of the producer's analysis raster.
    'matched-canvas-fold-columns-discarded': 'code-only',
    // canvasDpi/finestPageDpi: the grid the producer resolved for itself.
    'matched-canvas-document-dpi-normalized': 'code-only',
    // appliedDpi/requestedDpi: likewise; the page is the comparison key.
    'matched-canvas-page-dpi-capped': 'code-only',
    // appliedDpiThousandths/requestedDpiThousandths: the producer's render DPI.
    'render-dpi-limited': 'code-only',
    // pages: a document-level list, identical for every path that reports it.
    'matched-canvas-content-fitted-pages': 'code-and-params',
    'matched-canvas-pages-resampled': 'code-and-params',
    'matched-canvas-pages-scaled-in-place': 'code-and-params',
    // detail: what the producer could not measure about this document.
    'matched-canvas-geometry-unmeasured': 'code-and-params',
    // Parameterless conditions: the code is the whole signature already, and
    // classifying them explicitly is what keeps a later parameter from being
    // added to one of them without a decision being made about it.
    'matched-canvas-margins-reduced': 'code-and-params',
    'matched-canvas-margins-unavailable': 'code-and-params',
    'matched-canvas-optical-centering-fallback': 'code-and-params',
    'matched-canvas-dropped': 'code-and-params',
};

/**
 * The stable signature two paths' conditions are compared by, under the policy
 * above. A code with no decision recorded is a failure rather than a default:
 * guessing either way would silently either invent a disagreement or drop one.
 */
export function scanCleanupParityWarningSignature(event: TScanCleanupWarningEvent) {
    const comparison: TScanCleanupParityWarningComparison | undefined = (
        SCAN_CLEANUP_PARITY_WARNING_COMPARISON_POLICY as Record<
            string,
            TScanCleanupParityWarningComparison | undefined
        >
    )[event.code];
    if (comparison === undefined) {
        throw new Error(
            `Scan-cleanup parity has no warning comparison policy for "${event.code}"`,
        );
    }
    return comparison === 'code-only' ? JSON.stringify({code: event.code}) : stableEventJson(event);
}

export interface IScanCleanupParityCapturedWarningEvent {
    event: TScanCleanupWarningEvent;
    formatted: string;
}

/**
 * Which typed events a path's published sentences came from, matched by exact
 * equality against the events the shared formatter produced.
 *
 * Each sentence takes one captured event out of the capture, so two identical
 * sentences consume two identical events and neither is counted twice. The
 * match is on the whole formatted string rather than on the capture's order, so
 * a producer that publishes its conditions in a different order than it formats
 * them is still attributed — and no English is parsed to do it. A sentence with
 * no captured event is an unstructured diagnostic, which carries no code by
 * definition; the caller proves the capture is empty afterwards, so no typed
 * event goes unattributed.
 */
export function attributeScanCleanupParityWarningEvents(
    capture: IScanCleanupParityCapturedWarningEvent[],
    warnings: readonly string[],
) {
    const events: TScanCleanupWarningEvent[] = [];
    for (const warning of warnings) {
        const index = capture.findIndex(captured => captured.formatted === warning);
        if (index === -1) continue;
        events.push(capture.splice(index, 1)[0]!.event);
    }
    return events;
}

export function compareScanCleanupParityObservations(
    observations: readonly IScanCleanupParityObservation[],
): IScanCleanupParityComparison[] {
    const groups = new Map<string, IScanCleanupParityObservation[]>();
    for (const observation of observations) {
        const key = observationKey(observation);
        groups.set(key, [
            ...groups.get(key) ?? [],
            observation,
        ]);
    }
    return [...groups.values()].map(group => {
        const first = group[0]!;
        const byPath = new Map(group.map(observation => [
            observation.path,
            observation,
        ]));
        const deltas: IScanCleanupParityDelta[] = [];
        const present = SCAN_CLEANUP_PARITY_PATHS.filter(path => byPath.has(path));
        for (let index = 0; index < present.length; index += 1) {
            for (let other = index + 1; other < present.length; other += 1) {
                const leftPath = present[index]!;
                const rightPath = present[other]!;
                const left = byPath.get(leftPath)!;
                const right = byPath.get(rightPath)!;
                const pushDelta = (delta: {
                    field: string;
                    unit: IScanCleanupParityDelta['unit'];
                    leftValue: number | string;
                    rightValue: number | string;
                    delta: number;
                    tolerance: number;
                    withinTolerance: boolean;
                }) => {
                    deltas.push({
                        caseId: first.caseId,
                        sourcePageNumber: first.sourcePageNumber,
                        half: first.half,
                        field: delta.field,
                        unit: delta.unit,
                        left: {
                            path: leftPath,
                            value: delta.leftValue,
                        },
                        right: {
                            path: rightPath,
                            value: delta.rightValue,
                        },
                        delta: delta.delta,
                        toleranceMm: SCAN_CLEANUP_PARITY_TOLERANCE_MM,
                        tolerance: delta.tolerance,
                        withinTolerance: delta.withinTolerance,
                    });
                };
                for (const numeric of MM_FIELDS) {
                    const delta = Math.abs(numeric.read(left) - numeric.read(right));
                    pushDelta({
                        field: numeric.field,
                        unit: 'mm',
                        leftValue: numeric.read(left),
                        rightValue: numeric.read(right),
                        delta,
                        tolerance: SCAN_CLEANUP_PARITY_TOLERANCE_MM,
                        withinTolerance: withinTolerance(delta, SCAN_CLEANUP_PARITY_TOLERANCE_MM),
                    });
                }
                for (const ratio of RATIO_FIELDS) {
                    // A scale delta is only meaningful as the length it moves
                    // on the canvas, so the one global tolerance converts here
                    // instead of a second tolerance being invented for ratios.
                    const span = Math.max(ratio.span(left), ratio.span(right));
                    const tolerance = SCAN_CLEANUP_PARITY_TOLERANCE_MM / span;
                    const delta = Math.abs(ratio.read(left) - ratio.read(right));
                    pushDelta({
                        field: ratio.field,
                        unit: 'ratio',
                        leftValue: ratio.read(left),
                        rightValue: ratio.read(right),
                        delta,
                        tolerance,
                        withinTolerance: withinTolerance(delta, tolerance),
                    });
                }
                for (const axis of [
                    'horizontal',
                    'vertical',
                ] as const) {
                    const leftValue = left.deliveredAlignment[axis];
                    const rightValue = right.deliveredAlignment[axis];
                    pushDelta({
                        field: `deliveredAlignment.${axis}`,
                        unit: 'code',
                        leftValue,
                        rightValue,
                        delta: leftValue === rightValue ? 0 : 1,
                        tolerance: 0,
                        withinTolerance: leftValue === rightValue,
                    });
                }
                if (left.warningEvents !== null && right.warningEvents !== null) {
                    const leftCodes = left.warningEvents.map(scanCleanupParityWarningSignature).sort();
                    const rightCodes = right.warningEvents.map(scanCleanupParityWarningSignature).sort();
                    const matched = JSON.stringify(leftCodes) === JSON.stringify(rightCodes);
                    pushDelta({
                        field: 'warningEventSignatures',
                        unit: 'code',
                        leftValue: JSON.stringify(leftCodes),
                        rightValue: JSON.stringify(rightCodes),
                        delta: matched ? 0 : 1,
                        tolerance: 0,
                        withinTolerance: matched,
                    });
                }
            }
        }
        return {
            caseId: first.caseId,
            sourcePageNumber: first.sourcePageNumber,
            half: first.half,
            paths: [...present],
            missingPaths: SCAN_CLEANUP_PARITY_PATHS.filter(path => !byPath.has(path)),
            deltas,
        } satisfies IScanCleanupParityComparison;
    });
}

/**
 * A path that could not answer for a case, with the run's own reason. The
 * lossless assembler is skipped whenever matched page size has to re-render a
 * page, so a document whose paper differs from the canvas has no lossless
 * placement to compare — recording that is not the same as passing on two
 * paths without saying so.
 */
export interface IScanCleanupParityPathSubstitution {
    caseId: string;
    path: TScanCleanupParityPath;
    reason: string;
}

/**
 * A path whose typed SC-IMP-003 events this run could not reach, with the
 * blocker stated. Recording it is what keeps a path that publishes no codes
 * from reading as a path whose codes agreed.
 */
export interface IScanCleanupParityTypedWarningLimitation {
    path: TScanCleanupParityPath;
    reason: string;
}

export interface IScanCleanupParityFixtureIdentity {
    fixture: TScanCleanupParityFixture;
    fileName: string;
    sha256: string;
    bytes: number;
    pageCount: number;
}

export interface IScanCleanupParityReport {
    schemaVersion: 1;
    unit: typeof SCAN_CLEANUP_PARITY_UNIT;
    tolerance: {
        millimetres: number;
        rasterCanvasPixels: number;
        canvasDpi: number;
    };
    /**
     * The requirements SC-IMP-004 declares, what these cases actually cover and
     * what is left. A report is evidence for the package only if the last list
     * is empty, so the report states it instead of leaving it to be recounted.
     */
    coverage: {
        requirements: TScanCleanupParityRequirement[];
        covered: TScanCleanupParityRequirement[];
        gaps: TScanCleanupParityRequirement[];
    };
    fixtures: IScanCleanupParityFixtureIdentity[];
    cases: Array<{
        id: string;
        fixture: TScanCleanupParityFixture;
        fixtureSha256: string;
        intent: string;
        marginsMm: IScanCleanupParityMarginsMm;
        layoutMode: string;
        pageAlignment: string;
        covers: readonly TScanCleanupParityRequirement[];
        expectedPathSubstitutions: TScanCleanupParityPath[];
        observations: IScanCleanupParityObservation[];
    }>;
    comparisons: IScanCleanupParityComparison[];
    exceedances: IScanCleanupParityDelta[];
    pathSubstitutions: IScanCleanupParityPathSubstitution[];
    typedWarningChannelLimitations: IScanCleanupParityTypedWarningLimitation[];
}

export interface IScanCleanupParityEngineIdentity {
    binaryName: string;
    path: string;
    sha256: string;
    bytes: number;
}

/**
 * What the retained report was produced by and what it is. The engines pin the
 * builds all three paths ran against, the fixtures pin the documents, and the
 * report digest pins the evidence file itself — an identities file that named
 * the report only by path would not survive the report being regenerated.
 */
export interface IScanCleanupParityIdentities {
    schemaVersion: 1;
    engines: IScanCleanupParityEngineIdentity[];
    fixtures: IScanCleanupParityFixtureIdentity[];
    report: {
        path: string;
        sha256: string;
        bytes: number;
    };
}

/**
 * Where the files an identities record claims actually are, so the record can
 * be checked against bytes instead of against the numbers it carries. Engines
 * and the report name themselves by path; fixture identities name a file
 * because the corpus regenerates them per run, so the directory holding them
 * is stated here rather than assumed. Every claimed file must exist and match:
 * an identities record whose files cannot be read is evidence about nothing.
 */
export interface IScanCleanupParityIdentitySources {fixtureDir: string;}

function fail(detail: string): never {
    throw new Error(`Invalid scan-cleanup parity report: ${detail}`);
}

function requireRecord(value: unknown, label: string) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string) {
    if (!Array.isArray(value)) fail(`${label} must be an array`);
    return value;
}

function requireFiniteNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`);
    return value;
}

function requireNonEmptyString(value: unknown, label: string) {
    if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
    return value;
}

function requireSha256(value: unknown, label: string) {
    const digest = requireNonEmptyString(value, label);
    if (!/^[0-9a-f]{64}$/u.test(digest)) fail(`${label} must be a SHA-256 digest`);
    return digest;
}

function requirePositiveByteCount(value: unknown, label: string) {
    const bytes = requireFiniteNumber(value, label);
    if (!Number.isInteger(bytes) || bytes <= 0) fail(`${label} must be a positive byte count`);
    return bytes;
}

/**
 * What a file on disk actually is. An identities record is evidence about
 * files, so re-reading the values it carries would prove nothing: the digest
 * and the size compared against it are both taken from the bytes themselves.
 */
function requireFileMatchesIdentity(
    path: string,
    label: string,
    claimed: {
        sha256: string;
        bytes: number;
    },
) {
    if (!existsSync(path)) fail(`${label} names a file that is not there: ${path}`);
    const contents = readFileSync(path);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (contents.byteLength !== claimed.bytes) {
        fail(
            `${label}.bytes claims ${String(claimed.bytes)} but ${path} `
            + `is ${String(contents.byteLength)} bytes`,
        );
    }
    if (sha256 !== claimed.sha256) {
        fail(`${label}.sha256 claims ${claimed.sha256} but ${path} hashes to ${sha256}`);
    }
}

function requirePath(value: unknown, label: string): TScanCleanupParityPath {
    const path = requireNonEmptyString(value, label);
    if (!SCAN_CLEANUP_PARITY_PATHS.includes(path as TScanCleanupParityPath)) {
        fail(`${label} is not a known fitter path`);
    }
    return path as TScanCleanupParityPath;
}

function requireWarningEvents(value: unknown, label: string) {
    if (value === null) {
        return;
    }
    for (const [
        index,
        entry,
    ] of requireArray(value, label).entries()) {
        const event = requireRecord(entry, `${label}[${String(index)}]`);
        const code = requireNonEmptyString(event.code, `${label}[${String(index)}].code`);
        if (!SCAN_CLEANUP_WARNING_EVENT_CODES.includes(code as TScanCleanupWarningEvent['code'])) {
            fail(`${label}[${String(index)}].code is not a declared SC-IMP-003 warning code`);
        }
    }
}

/**
 * The report is the package's evidence, so a malformed one has to fail as
 * loudly as an out-of-tolerance placement rather than being filed as a pass.
 */
export function assertScanCleanupParityReport(value: unknown): asserts value is IScanCleanupParityReport {
    const report = requireRecord(value, 'report');
    if (report.schemaVersion !== 1) fail('schemaVersion must be 1');
    if (report.unit !== SCAN_CLEANUP_PARITY_UNIT) fail(`unit must be "${SCAN_CLEANUP_PARITY_UNIT}"`);
    const tolerance = requireRecord(report.tolerance, 'tolerance');
    const millimetres = requireFiniteNumber(tolerance.millimetres, 'tolerance.millimetres');
    const canvasDpi = requireFiniteNumber(tolerance.canvasDpi, 'tolerance.canvasDpi');
    const pixels = requireFiniteNumber(tolerance.rasterCanvasPixels, 'tolerance.rasterCanvasPixels');
    if (pixels > SCAN_CLEANUP_PARITY_TOLERANCE_RASTER_PIXELS) {
        fail('tolerance.rasterCanvasPixels must not exceed one raster canvas pixel');
    }
    if (Math.abs(millimetres - (pixels * 25.4 / canvasDpi)) > 1e-9) {
        fail('tolerance.millimetres must equal the declared pixel tolerance at the declared canvas DPI');
    }
    const fixtures = requireArray(report.fixtures, 'fixtures');
    if (fixtures.length === 0) fail('fixtures must not be empty');
    // One fixture identity per document, and one document per identity: a
    // duplicate name would let a case point at two different files, and a
    // duplicate digest would let two named fixtures be the same bytes while
    // the report claimed two distinct documents were exercised.
    const identityByDigest = new Map<string, string>();
    const namedFixtures = new Set<string>();
    for (const [
        index,
        entry,
    ] of fixtures.entries()) {
        const fixture = requireRecord(entry, `fixtures[${String(index)}]`);
        const name = requireNonEmptyString(fixture.fixture, `fixtures[${String(index)}].fixture`);
        const sha256 = requireSha256(fixture.sha256, `fixtures[${String(index)}].sha256`);
        requireNonEmptyString(fixture.fileName, `fixtures[${String(index)}].fileName`);
        requirePositiveByteCount(fixture.bytes, `fixtures[${String(index)}].bytes`);
        requireFiniteNumber(fixture.pageCount, `fixtures[${String(index)}].pageCount`);
        if (namedFixtures.has(name)) fail(`fixtures declares "${name}" twice`);
        if (identityByDigest.has(sha256)) {
            fail(`fixtures declares one digest for both "${identityByDigest.get(sha256)!}" and "${name}"`);
        }
        namedFixtures.add(name);
        identityByDigest.set(sha256, name);
    }
    const cases = requireArray(report.cases, 'cases');
    if (cases.length === 0) fail('cases must not be empty');
    const caseIds = new Set<string>();
    const covered = new Set<string>();
    for (const [
        index,
        entry,
    ] of cases.entries()) {
        const parityCase = requireRecord(entry, `cases[${String(index)}]`);
        const caseId = requireNonEmptyString(parityCase.id, `cases[${String(index)}].id`);
        if (caseIds.has(caseId)) fail(`cases declares "${caseId}" twice`);
        caseIds.add(caseId);
        const fixture = requireNonEmptyString(parityCase.fixture, `cases[${String(index)}].fixture`);
        const fixtureSha256 = requireSha256(parityCase.fixtureSha256, `cases[${String(index)}].fixtureSha256`);
        // The digest, not the name, is what ties a case to the bytes it ran
        // against, so it has to select exactly one recorded identity and that
        // identity has to be the fixture the case names.
        const matches = fixtures.filter(candidate => (candidate as Record<string, unknown>).sha256 === fixtureSha256);
        if (matches.length !== 1) {
            fail(`cases[${String(index)}].fixtureSha256 matches ${String(matches.length)} fixture identities, not one`);
        }
        if ((matches[0] as Record<string, unknown>).fixture !== fixture) {
            fail(`cases[${String(index)}].fixtureSha256 is the digest of a different fixture than "${fixture}"`);
        }
        for (const [
            coverIndex,
            requirement,
        ] of requireArray(parityCase.covers, `cases[${String(index)}].covers`).entries()) {
            const label = `cases[${String(index)}].covers[${String(coverIndex)}]`;
            const value = requireNonEmptyString(requirement, label);
            if (!SCAN_CLEANUP_PARITY_REQUIREMENTS.includes(value as TScanCleanupParityRequirement)) {
                fail(`${label} is not a declared SC-IMP-004 requirement`);
            }
            covered.add(value);
        }
        const expectedSubstitutions = requireArray(
            parityCase.expectedPathSubstitutions,
            `cases[${String(index)}].expectedPathSubstitutions`,
        );
        for (const [
            substitutionIndex,
            substitution,
        ] of expectedSubstitutions.entries()) {
            requirePath(
                substitution,
                `cases[${String(index)}].expectedPathSubstitutions[${String(substitutionIndex)}]`,
            );
        }
        const observations = requireArray(parityCase.observations, `cases[${String(index)}].observations`);
        if (observations.length === 0) fail(`cases[${String(index)}].observations must not be empty`);
        for (const [
            observationIndex,
            observationValue,
        ] of observations.entries()) {
            const label = `cases[${String(index)}].observations[${String(observationIndex)}]`;
            const observation = requireRecord(observationValue, label);
            if (observation.unit !== SCAN_CLEANUP_PARITY_UNIT) fail(`${label}.unit must be "${SCAN_CLEANUP_PARITY_UNIT}"`);
            if (observation.caseId !== caseId) fail(`${label}.caseId must be "${caseId}"`);
            requirePath(observation.path, `${label}.path`);
            if (![
                'full',
                'left',
                'right',
            ].includes(String(observation.half))) fail(`${label}.half must name a split half`);
            requireFiniteNumber(observation.sourcePageNumber, `${label}.sourcePageNumber`);
            requireFiniteNumber(observation.outputOrdinal, `${label}.outputOrdinal`);
            requireFiniteNumber(observation.sourceRotationDegrees, `${label}.sourceRotationDegrees`);
            requireFiniteNumber(observation.rotationDegrees, `${label}.rotationDegrees`);
            if (observation.sourceDpi !== null) requireFiniteNumber(observation.sourceDpi, `${label}.sourceDpi`);
            requireFiniteNumber(observation.canvasDpi, `${label}.canvasDpi`);
            requireNonEmptyString(observation.canvasGrid, `${label}.canvasGrid`);
            requireFiniteNumber(observation.toleranceMm, `${label}.toleranceMm`);
            requireRecord(observation.requestedMarginsMm, `${label}.requestedMarginsMm`);
            requireRecord(observation.deliveredMarginsMm, `${label}.deliveredMarginsMm`);
            requireRecord(observation.contentRectMm, `${label}.contentRectMm`);
            requireRecord(observation.canvasRectMm, `${label}.canvasRectMm`);
            requireRecord(observation.placementOffsetMm, `${label}.placementOffsetMm`);
            requireRecord(observation.contentScaleOfCanvas, `${label}.contentScaleOfCanvas`);
            requireRecord(observation.deliveredAlignment, `${label}.deliveredAlignment`);
            requireWarningEvents(observation.warningEvents, `${label}.warningEvents`);
            requireArray(observation.warningMessages, `${label}.warningMessages`);
        }
    }
    const coverage = requireRecord(report.coverage, 'coverage');
    const declared = requireArray(coverage.requirements, 'coverage.requirements').map(String);
    if (
        declared.length !== SCAN_CLEANUP_PARITY_REQUIREMENTS.length
        || SCAN_CLEANUP_PARITY_REQUIREMENTS.some(requirement => !declared.includes(requirement))
    ) {
        fail('coverage.requirements must be exactly the requirements SC-IMP-004 declares');
    }
    const reportedCovered = requireArray(coverage.covered, 'coverage.covered').map(String);
    if (
        reportedCovered.length !== covered.size
        || reportedCovered.some(requirement => !covered.has(requirement))
    ) {
        fail('coverage.covered must be exactly the requirements the cases claim');
    }
    const gaps = declared.filter(requirement => !covered.has(requirement));
    const reportedGaps = requireArray(coverage.gaps, 'coverage.gaps').map(String);
    if (reportedGaps.length !== gaps.length || gaps.some(gap => !reportedGaps.includes(gap))) {
        fail('coverage.gaps must be the declared requirements the cases do not claim');
    }
    if (gaps.length > 0) fail(`cases leave ${gaps.join(', ')} uncovered`);
    requireArray(report.comparisons, 'comparisons');
    requireArray(report.exceedances, 'exceedances');
    for (const [
        index,
        entry,
    ] of requireArray(report.pathSubstitutions, 'pathSubstitutions').entries()) {
        const substitution = requireRecord(entry, `pathSubstitutions[${String(index)}]`);
        const caseId = requireNonEmptyString(substitution.caseId, `pathSubstitutions[${String(index)}].caseId`);
        if (!caseIds.has(caseId)) fail(`pathSubstitutions[${String(index)}].caseId names no case in this report`);
        requireNonEmptyString(substitution.reason, `pathSubstitutions[${String(index)}].reason`);
        requirePath(substitution.path, `pathSubstitutions[${String(index)}].path`);
    }
    const limitedPaths = new Set<TScanCleanupParityPath>();
    for (const [
        index,
        entry,
    ] of requireArray(report.typedWarningChannelLimitations, 'typedWarningChannelLimitations').entries()) {
        const limitation = requireRecord(entry, `typedWarningChannelLimitations[${String(index)}]`);
        requireNonEmptyString(limitation.reason, `typedWarningChannelLimitations[${String(index)}].reason`);
        limitedPaths.add(requirePath(limitation.path, `typedWarningChannelLimitations[${String(index)}].path`));
    }
    // Every path that published no typed events owes the report a blocker, and
    // a path that did publish them cannot be excused from the comparison.
    const observations = cases.flatMap(entry => (entry as {observations: unknown[]}).observations);
    for (const path of SCAN_CLEANUP_PARITY_PATHS) {
        const observed = observations.filter(entry => (entry as {path: string}).path === path);
        if (observed.length === 0) continue;
        const untyped = observed.some(entry => (entry as {warningEvents: unknown}).warningEvents === null);
        if (untyped && !limitedPaths.has(path)) {
            fail(`${path} published no typed warning events and declared no blocker`);
        }
        if (!untyped && limitedPaths.has(path)) {
            fail(`${path} published typed warning events and cannot declare a blocker`);
        }
    }
}

export function buildScanCleanupParityReport(input: {
    fixtures: readonly IScanCleanupParityFixtureIdentity[];
    cases: ReadonlyArray<{
        parityCase: IScanCleanupParityCase;
        fixtureSha256: string;
        observations: readonly IScanCleanupParityObservation[];
    }>;
    pathSubstitutions?: readonly IScanCleanupParityPathSubstitution[];
    typedWarningChannelLimitations?: readonly IScanCleanupParityTypedWarningLimitation[];
}): IScanCleanupParityReport {
    const observations = input.cases.flatMap(entry => entry.observations);
    const comparisons = compareScanCleanupParityObservations(observations);
    const covered = SCAN_CLEANUP_PARITY_REQUIREMENTS.filter(requirement => input.cases
        .some(entry => entry.parityCase.covers.includes(requirement)));
    const report: IScanCleanupParityReport = {
        schemaVersion: 1,
        unit: SCAN_CLEANUP_PARITY_UNIT,
        tolerance: {
            millimetres: SCAN_CLEANUP_PARITY_TOLERANCE_MM,
            rasterCanvasPixels: SCAN_CLEANUP_PARITY_TOLERANCE_RASTER_PIXELS,
            canvasDpi: SCAN_CLEANUP_PARITY_CANVAS_DPI,
        },
        coverage: {
            requirements: [...SCAN_CLEANUP_PARITY_REQUIREMENTS],
            covered: [...covered],
            gaps: SCAN_CLEANUP_PARITY_REQUIREMENTS.filter(requirement => !covered.includes(requirement)),
        },
        fixtures: [...input.fixtures],
        cases: input.cases.map(entry => ({
            id: entry.parityCase.id,
            fixture: entry.parityCase.fixture,
            fixtureSha256: entry.fixtureSha256,
            intent: entry.parityCase.intent,
            marginsMm: entry.parityCase.marginsMm,
            layoutMode: entry.parityCase.layoutMode,
            pageAlignment: entry.parityCase.pageAlignment,
            covers: entry.parityCase.covers,
            expectedPathSubstitutions: [...entry.parityCase.expectedPathSubstitutions ?? []],
            observations: [...entry.observations],
        })),
        comparisons,
        exceedances: comparisons.flatMap(comparison => comparison.deltas.filter(delta => !delta.withinTolerance)),
        pathSubstitutions: [...input.pathSubstitutions ?? []],
        typedWarningChannelLimitations: [...input.typedWarningChannelLimitations ?? []],
    };
    // The build is the first reader of its own evidence: a report that cannot
    // pass the validator is never written, let alone retained.
    assertScanCleanupParityReport(report);
    return report;
}

export function buildScanCleanupParityIdentities(input: {
    engines: readonly IScanCleanupParityEngineIdentity[];
    report: IScanCleanupParityReport;
    reportPath: string;
    reportSha256: string;
    reportBytes: number;
    fixtureDir: string;
}): IScanCleanupParityIdentities {
    const identities: IScanCleanupParityIdentities = {
        schemaVersion: 1,
        engines: [...input.engines],
        fixtures: [...input.report.fixtures],
        report: {
            path: input.reportPath,
            sha256: input.reportSha256,
            bytes: input.reportBytes,
        },
    };
    assertScanCleanupParityIdentities(identities, input.report, {fixtureDir: input.fixtureDir});
    return identities;
}

/**
 * The identities file is what a later reader checks the retained evidence
 * against, so it has to pin every input the run consumed and the output it
 * produced. A fixture the report measured but the identities file omits would
 * leave that document unidentified in the record.
 *
 * Every digest and byte count it declares is re-derived here from the file it
 * names rather than trusted: an identities record that agreed only with itself
 * would still pass while the evidence beside it had been replaced.
 */
export function assertScanCleanupParityIdentities(
    value: unknown,
    report: IScanCleanupParityReport,
    sources: IScanCleanupParityIdentitySources,
): asserts value is IScanCleanupParityIdentities {
    const identities = requireRecord(value, 'identities');
    if (identities.schemaVersion !== 1) fail('identities.schemaVersion must be 1');
    const engines = requireArray(identities.engines, 'identities.engines');
    if (engines.length === 0) fail('identities.engines must not be empty');
    const binaryNames = new Set<string>();
    for (const [
        index,
        entry,
    ] of engines.entries()) {
        const engine = requireRecord(entry, `identities.engines[${String(index)}]`);
        const binaryName = requireNonEmptyString(engine.binaryName, `identities.engines[${String(index)}].binaryName`);
        if (binaryNames.has(binaryName)) fail(`identities.engines declares "${binaryName}" twice`);
        binaryNames.add(binaryName);
        const enginePath = requireNonEmptyString(engine.path, `identities.engines[${String(index)}].path`);
        requireFileMatchesIdentity(enginePath, `identities.engines[${String(index)}]`, {
            sha256: requireSha256(engine.sha256, `identities.engines[${String(index)}].sha256`),
            bytes: requirePositiveByteCount(engine.bytes, `identities.engines[${String(index)}].bytes`),
        });
    }
    const fixtures = requireArray(identities.fixtures, 'identities.fixtures');
    const recorded = new Set(fixtures.map(entry => JSON.stringify(entry)));
    if (fixtures.length !== report.fixtures.length || report.fixtures.some(
        fixture => !recorded.has(JSON.stringify(fixture)),
    )) {
        fail('identities.fixtures must be exactly the fixture identities the report measured');
    }
    for (const [
        index,
        entry,
    ] of fixtures.entries()) {
        const fixture = requireRecord(entry, `identities.fixtures[${String(index)}]`);
        const fileName = requireNonEmptyString(fixture.fileName, `identities.fixtures[${String(index)}].fileName`);
        requireFileMatchesIdentity(
            join(sources.fixtureDir, fileName),
            `identities.fixtures[${String(index)}]`,
            {
                sha256: requireSha256(fixture.sha256, `identities.fixtures[${String(index)}].sha256`),
                bytes: requirePositiveByteCount(fixture.bytes, `identities.fixtures[${String(index)}].bytes`),
            },
        );
    }
    const reportIdentity = requireRecord(identities.report, 'identities.report');
    const reportPath = requireNonEmptyString(reportIdentity.path, 'identities.report.path');
    requireFileMatchesIdentity(reportPath, 'identities.report', {
        sha256: requireSha256(reportIdentity.sha256, 'identities.report.sha256'),
        bytes: requirePositiveByteCount(reportIdentity.bytes, 'identities.report.bytes'),
    });
}
