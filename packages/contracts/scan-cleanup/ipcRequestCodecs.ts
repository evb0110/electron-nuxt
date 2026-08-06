import {isRecord} from '@contracts/runtimeGuards';
import type {
    IScanCleanupDocumentPrior,
    IScanCleanupManualZones,
    IScanCleanupPageOverride,
    TScanCleanupLayoutByPage,
    TScanCleanupPageAlignment,
} from '@contracts/scan-cleanup/domain';
import {
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX,
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN,
    SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES,
    SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES,
} from '@contracts/scan-cleanup/domain';
import type {
    IScanCleanupMarginsMm,
    IScanCleanupNormalizedRect,
} from '@contracts/scan-cleanup/geometry';
import {SCAN_CLEANUP_MARGIN_MAX_MM} from '@contracts/scan-cleanup/geometry';
import {
    consumeScanCleanupPages,
    consumeScanCleanupVertices,
    consumeScanCleanupZones,
    createScanCleanupInputBudget,
    decodeBoundedScanCleanupString,
    decodeScanCleanupPageKey,
    decodeScanCleanupPageNumber,
    type IScanCleanupInputBudget,
    SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    SCAN_CLEANUP_INPUT_MAX_PAGES,
    SCAN_CLEANUP_INPUT_MAX_PATH_BYTES,
    SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON,
    SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE,
} from '@contracts/scan-cleanup/inputLimits';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewRequest,
    IScanCleanupPagePlanEvidence,
    IScanCleanupSourcePageMetadata,
    IScanCleanupStartRequest,
    IScanCleanupTextToneDiagnostics,
} from '@contracts/scan-cleanup/ipc';
import {isScanCleanupOutputMode} from '@contracts/scan-cleanup/outputModeGuards';
import {assertSimpleScanCleanupPolygon} from '@contracts/scan-cleanup/simplePolygon';

function decodeTextToneEvidence(value: unknown, label: string): IScanCleanupTextToneDiagnostics {
    if (
        !isRecord(value)
        || typeof value.applied !== 'boolean'
        || ![
            'applied',
            'picture-evidence',
            'insufficient-text',
            'tonal-mass-outside-text',
            'already-dark',
        ].includes(String(value.rule))
        || !Number.isSafeInteger(value.textLineCount)
        || Number(value.textLineCount) < 0
        || !Number.isSafeInteger(value.textInkPixels)
        || Number(value.textInkPixels) < 0
    ) throw new Error(`invalid scan-cleanup ${label}`);
    const finiteFraction = (candidate: unknown) => (
        typeof candidate === 'number'
        && Number.isFinite(candidate)
        && candidate >= 0
        && candidate <= 1
    );
    const nullableFinite = (candidate: unknown) => (
        candidate === null || typeof candidate === 'number' && Number.isFinite(candidate)
    );
    if (
        !finiteFraction(value.pictureFraction)
        || !finiteFraction(value.outsideMidtoneFraction)
        || !finiteFraction(value.outsideMidtoneLargestComponentFraction)
        || !finiteFraction(value.outsideMidtoneLargestComponentWidthFraction)
        || !finiteFraction(value.outsideMidtoneLargestComponentHeightFraction)
        || !(value.inkAnchor === null
            || Number.isSafeInteger(value.inkAnchor)
            && Number(value.inkAnchor) >= 0
            && Number(value.inkAnchor) <= 255)
        || !nullableFinite(value.blackPoint)
        || !nullableFinite(value.slope)
        || value.applied !== (value.rule === 'applied')
        || value.applied !== (value.blackPoint !== null && value.slope !== null)
    ) throw new Error(`invalid scan-cleanup ${label}`);
    return {
        applied: value.applied,
        rule: value.rule as IScanCleanupTextToneDiagnostics['rule'],
        textLineCount: Number(value.textLineCount),
        textInkPixels: Number(value.textInkPixels),
        pictureFraction: Number(value.pictureFraction),
        outsideMidtoneFraction: Number(value.outsideMidtoneFraction),
        outsideMidtoneLargestComponentFraction: Number(
            value.outsideMidtoneLargestComponentFraction,
        ),
        outsideMidtoneLargestComponentWidthFraction: Number(
            value.outsideMidtoneLargestComponentWidthFraction,
        ),
        outsideMidtoneLargestComponentHeightFraction: Number(
            value.outsideMidtoneLargestComponentHeightFraction,
        ),
        inkAnchor: value.inkAnchor === null ? null : Number(value.inkAnchor),
        blackPoint: value.blackPoint === null ? null : Number(value.blackPoint),
        slope: value.slope === null ? null : Number(value.slope),
    };
}

export function decodeScanCleanupPagePlanEvidence(
    value: unknown,
    pageNumber: number,
): IScanCleanupPagePlanEvidence {
    const decodedPageNumber = decodeScanCleanupPageNumber(
        pageNumber,
        'page-plan evidence page number',
    );
    if (
        !isRecord(value)
        || value.pageNumber !== decodedPageNumber
        || ![
            0,
            90,
            180,
            270,
        ].includes(Number(value.rotationDegrees))
        || !isLayoutClassification(value.layoutClassification)
        || !isRecord(value.outputs)
    ) {
        throw new Error('invalid scan-cleanup page-plan evidence');
    }
    const rotationDegrees = value.rotationDegrees as IScanCleanupPagePlanEvidence['rotationDegrees'];
    const automaticSplit = value.automaticSplit === undefined
        ? undefined
        : (() => {
            if (!isRecord(value.automaticSplit)) {
                throw new Error('invalid scan-cleanup automatic split');
            }
            const xNormalized = decodeNormalizedValue(
                value.automaticSplit.xNormalized,
                'automatic split x',
            );
            if (xNormalized <= 0 || xNormalized >= 1) {
                throw new Error('invalid scan-cleanup automatic split');
            }
            return {
                xNormalized,
                rotationDegrees: decodeGeometryRotation(
                    value.automaticSplit.rotationDegrees,
                    rotationDegrees,
                    'automatic split',
                ),
            };
        })();
    const outputs = decodeOutputMap(value.outputs, (output, label) => {
        if (!isRecord(output)) {
            throw new Error(`invalid scan-cleanup ${label}`);
        }
        const detectedSkewDegrees = output.detectedSkewDegrees === undefined
            ? undefined
            : decodeFiniteNumber(output.detectedSkewDegrees, `${label} skew`);
        if (
            detectedSkewDegrees !== undefined
            && (detectedSkewDegrees < SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES
                || detectedSkewDegrees > SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES)
        ) {
            throw new Error(`invalid scan-cleanup ${label} skew`);
        }
        const contentBox = output.contentBox === undefined
            ? undefined
            : decodeNormalizedRect(output.contentBox, `${label} content box`, rotationDegrees);
        const textToneDiagnostics = output.textToneDiagnostics === undefined
            ? undefined
            : decodeTextToneEvidence(output.textToneDiagnostics, `${label} text tone`);
        if (
            contentBox === undefined
            && detectedSkewDegrees === undefined
            && textToneDiagnostics === undefined
        ) {
            throw new Error(`invalid scan-cleanup ${label}`);
        }
        return {
            ...(contentBox === undefined ? {} : {contentBox}),
            ...(detectedSkewDegrees === undefined ? {} : {detectedSkewDegrees}),
            ...(textToneDiagnostics === undefined ? {} : {textToneDiagnostics}),
        };
    }, 'automatic page-plan output');
    return {
        pageNumber: decodedPageNumber,
        rotationDegrees,
        layoutClassification: value.layoutClassification,
        ...(automaticSplit === undefined ? {} : {automaticSplit}),
        outputs,
    };
}

function requireIpcArgumentCount(
    args: readonly unknown[],
    limits: {
        min: number;
        max: number
    },
) {
    if (args.length < limits.min || args.length > limits.max) {
        throw new Error(`expected ${limits.min}-${limits.max} arguments, received ${args.length}`);
    }
}

// A retained window is the navigation window plus whatever the renderer still
// has in flight; it can never legitimately name more pages than that.
const SCAN_CLEANUP_RETAIN_PAGES_MAX = 16;

function decodeRetainedPages(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length > SCAN_CLEANUP_RETAIN_PAGES_MAX) {
        throw new Error('invalid scan-cleanup retained preview pages');
    }
    return value.map(page => decodeScanCleanupPageNumber(page, 'retained preview page'));
}

export function decodePreviewCancelArgs(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 1,
    });
    const value = args[0];
    if (
        !isRecord(value)
        || (value.invalidateRawCache !== undefined && typeof value.invalidateRawCache !== 'boolean')
    ) throw new Error('invalid scan-cleanup preview cancellation');
    const sourcePdfPath = decodeBoundedScanCleanupString(
        value.sourcePdfPath,
        'preview cancellation path',
        SCAN_CLEANUP_INPUT_MAX_PATH_BYTES,
    );
    const retainPages = decodeRetainedPages(value.retainPages);
    return [{
        sourcePdfPath,
        ...decodeOwnerContext(value),
        ...(value.invalidateRawCache === undefined ? {} : {invalidateRawCache: value.invalidateRawCache}),
        ...(retainPages === undefined ? {} : {retainPages}),
    }] as [IScanCleanupPreviewCancelRequest];
}

export function decodeOwnedJobId(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 2,
        max: 2,
    });
    const [
        jobId,
        ownerValue,
    ] = args;
    if (!isRecord(ownerValue)) throw new Error('invalid scan-cleanup owner context');
    return [
        decodeBoundedScanCleanupString(jobId, 'job id', SCAN_CLEANUP_INPUT_MAX_ID_BYTES),
        decodeOwnerContext(ownerValue),
    ] as [string, ReturnType<typeof decodeOwnerContext>];
}

function decodeOwnerContext(value: Record<string, unknown>) {
    return {
        ownerId: decodeBoundedScanCleanupString(
            value.ownerId,
            'owner id',
            SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
        ),
        documentRevision: decodeBoundedScanCleanupString(
            value.documentRevision,
            'document revision',
            SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
        ),
    };
}

export function isLayoutClassification(value: unknown): value is IScanCleanupPreviewMetadata['layoutClassification'] {
    return value === 'single-uncut-page'
        || value === 'page-with-offcut'
        || value === 'two-page-spread';
}

export function decodeDocumentPrior(value: unknown): IScanCleanupDocumentPrior {
    if (
        !isRecord(value)
        || !isLayoutClassification(value.dominantLayout)
        || !isRecord(value.clusterDims)
        || typeof value.clusterDims.widthPx !== 'number'
        || !Number.isFinite(value.clusterDims.widthPx)
        || value.clusterDims.widthPx <= 0
        || typeof value.clusterDims.heightPx !== 'number'
        || !Number.isFinite(value.clusterDims.heightPx)
        || value.clusterDims.heightPx <= 0
        || typeof value.agreementStrength !== 'number'
        || !Number.isFinite(value.agreementStrength)
        || value.agreementStrength < 0
        || value.agreementStrength > 1
        || !(value.cutterRatioMedian === null || (
            typeof value.cutterRatioMedian === 'number'
            && Number.isFinite(value.cutterRatioMedian)
            && value.cutterRatioMedian >= 0.2
            && value.cutterRatioMedian <= 0.8
        ))
        || (value.dominantLayout === 'two-page-spread' && value.cutterRatioMedian === null)
    ) throw new Error('invalid scan-cleanup document prior');
    return {
        dominantLayout: value.dominantLayout,
        cutterRatioMedian: value.cutterRatioMedian,
        clusterDims: {
            widthPx: value.clusterDims.widthPx,
            heightPx: value.clusterDims.heightPx,
        },
        agreementStrength: value.agreementStrength,
    };
}

export function decodeOpenPdfPaths(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 1,
    });
    if (!Array.isArray(args[0]) || args[0].length > SCAN_CLEANUP_INPUT_MAX_PAGES) {
        throw new Error('invalid scan-cleanup open PDF paths');
    }
    return [args[0].map(path => decodeBoundedScanCleanupString(
        path,
        'open PDF path',
        SCAN_CLEANUP_INPUT_MAX_PATH_BYTES,
    ))] as [string[]];
}

function decodePageOverride(
    value: unknown,
    budget: IScanCleanupInputBudget,
): IScanCleanupPageOverride {
    if (
        !isRecord(value)
        || ![
            0,
            90,
            180,
            270,
        ].includes(Number(value.rotationDegrees))
        || ![
            'auto',
            'single',
            'spread',
            'keep-left',
            'keep-right',
        ].includes(String(value.layoutOverride))
        || typeof value.excluded !== 'boolean'
        || !(value.manualSplit === null || isRecord(value.manualSplit))
    ) throw new Error('invalid scan-cleanup page override');
    const rotationDegrees = value.rotationDegrees as IScanCleanupPageOverride['rotationDegrees'];
    const manualSplit = value.manualSplit === null
        ? null
        : {
            xNormalized: decodeNormalizedValue(value.manualSplit.xNormalized, 'manual split x'),
            rotationDegrees: decodeGeometryRotation(value.manualSplit.rotationDegrees, rotationDegrees, 'manual split'),
        };
    const manualContentBoxes = decodeOutputMap(
        value.manualContentBoxes,
        (item, label) => decodeNormalizedRect(item, label, rotationDegrees),
        'manual content box',
    );
    const manualZones = decodeManualZones(value.manualZones, rotationDegrees, budget);
    const placementOverrides = decodeOutputMap(value.placementOverrides, (item, label) => {
        if (!SCAN_CLEANUP_ALIGNMENTS.includes(String(item) as TScanCleanupAlignmentValue)) {
            throw new Error(`invalid scan-cleanup ${label}`);
        }
        return item as TScanCleanupPageAlignment;
    }, 'placement override');
    const marginsMm = value.marginsMm === undefined
        ? undefined
        : decodeMarginsMm(value.marginsMm, 'page override margins');
    const manualSkewDegrees = value.manualSkewDegrees === undefined
        ? undefined
        : decodeFiniteNumber(value.manualSkewDegrees, 'manual skew');
    if (
        manualSkewDegrees !== undefined
        && (manualSkewDegrees < SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES
            || manualSkewDegrees > SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES)
    ) throw new Error('invalid scan-cleanup manual skew');
    const outputModeOverride = value.outputModeOverride === undefined
        ? undefined
        : isScanCleanupOutputMode(value.outputModeOverride)
            ? value.outputModeOverride
            : (() => { throw new Error('invalid scan-cleanup page output mode override'); })();
    return {
        rotationDegrees,
        layoutOverride: value.layoutOverride as IScanCleanupPageOverride['layoutOverride'],
        excluded: value.excluded,
        manualSplit,
        ...(manualSkewDegrees === undefined ? {} : {manualSkewDegrees}),
        ...(outputModeOverride === undefined ? {} : {outputModeOverride}),
        ...(Object.keys(manualContentBoxes).length > 0 ? {manualContentBoxes} : {}),
        ...(manualZones === undefined ? {} : {manualZones}),
        ...(marginsMm === undefined ? {} : {marginsMm}),
        ...(Object.keys(placementOverrides).length > 0 ? {placementOverrides} : {}),
    };
}

function decodeManualZones(
    value: unknown,
    rotationDegrees: IScanCleanupPageOverride['rotationDegrees'],
    budget: IScanCleanupInputBudget,
): IScanCleanupManualZones | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value) || !Array.isArray(value.picture) || !Array.isArray(value.fill)) {
        throw new Error('invalid scan-cleanup manual zones');
    }
    const zoneCount = value.picture.length + value.fill.length;
    if (zoneCount > SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE) {
        throw new Error('too many scan-cleanup manual zones on one page');
    }
    consumeScanCleanupZones(budget, zoneCount, 'manual zones');
    const decodePolygon = (polygon: unknown, label: string) => {
        if (
            !isRecord(polygon)
            || !Array.isArray(polygon.points)
            || polygon.points.length < 3
            || polygon.points.length > SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON
        ) {
            throw new Error(`invalid scan-cleanup ${label}`);
        }
        consumeScanCleanupVertices(budget, polygon.points.length, 'manual-zone vertices');
        const decoded = {
            points: polygon.points.map((point, index) => {
                if (!isRecord(point)) throw new Error(`invalid scan-cleanup ${label} point ${index}`);
                return {
                    xNormalized: decodeNormalizedValue(point.xNormalized, `${label} point ${index} x`),
                    yNormalized: decodeNormalizedValue(point.yNormalized, `${label} point ${index} y`),
                };
            }),
            rotationDegrees: decodeGeometryRotation(polygon.rotationDegrees, rotationDegrees, label),
        };
        assertSimpleScanCleanupPolygon(decoded.points, label);
        return decoded;
    };
    return {
        picture: value.picture.map((zone, index) => {
            if (!isRecord(zone) || ![
                'eraser1',
                'painter2',
                'eraser3',
            ].includes(String(zone.layer))) throw new Error(`invalid scan-cleanup picture zone ${index}`);
            return {
                polygon: decodePolygon(zone.polygon, `picture zone ${index}`),
                layer: zone.layer as IScanCleanupManualZones['picture'][number]['layer'],
            };
        }),
        fill: value.fill.map((polygon, index) => decodePolygon(polygon, `fill zone ${index}`)),
    };
}

function decodeGeometryRotation(
    value: unknown,
    pageRotation: IScanCleanupPageOverride['rotationDegrees'],
    label: string,
) {
    if (![
        0,
        90,
        180,
        270,
    ].includes(Number(value)) || value !== pageRotation) {
        throw new Error(`invalid scan-cleanup ${label} rotation`);
    }
    return value as IScanCleanupPageOverride['rotationDegrees'];
}

function decodeNormalizedValue(value: unknown, label: string) {
    const decoded = decodeFiniteNumber(value, label);
    if (decoded < 0 || decoded > 1) throw new Error(`invalid scan-cleanup ${label}`);
    return decoded;
}

function decodeNormalizedRect(
    value: unknown,
    label: string,
    expectedRotation?: IScanCleanupNormalizedRect['rotationDegrees'],
): IScanCleanupNormalizedRect {
    if (!isRecord(value)) throw new Error(`invalid scan-cleanup ${label}`);
    const rotationDegrees = expectedRotation === undefined
        ? value.rotationDegrees
        : decodeGeometryRotation(value.rotationDegrees, expectedRotation, label);
    const rect = {
        xNormalized: decodeNormalizedValue(value.xNormalized, `${label} x`),
        yNormalized: decodeNormalizedValue(value.yNormalized, `${label} y`),
        widthNormalized: decodeNormalizedValue(value.widthNormalized, `${label} width`),
        heightNormalized: decodeNormalizedValue(value.heightNormalized, `${label} height`),
        rotationDegrees,
    };
    if (
        rect.widthNormalized <= 0
        || rect.heightNormalized <= 0
        || rect.xNormalized + rect.widthNormalized > 1
        || rect.yNormalized + rect.heightNormalized > 1
        || ![
            0,
            90,
            180,
            270,
        ].includes(Number(rect.rotationDegrees))
    ) {
        throw new Error(`invalid scan-cleanup ${label}`);
    }
    return rect as IScanCleanupNormalizedRect;
}

function decodeMarginsMm(value: unknown, label: string): IScanCleanupMarginsMm {
    if (!isRecord(value)) throw new Error(`invalid scan-cleanup ${label}`);
    const margins = {
        leftMm: value.leftMm,
        topMm: value.topMm,
        rightMm: value.rightMm,
        bottomMm: value.bottomMm,
    };
    if (Object.values(margins).some(margin => (
        typeof margin !== 'number'
        || !Number.isFinite(margin)
        || margin < 0
        || margin > SCAN_CLEANUP_MARGIN_MAX_MM
    ))) throw new Error(`invalid scan-cleanup ${label}`);
    return margins as IScanCleanupMarginsMm;
}

const SCAN_CLEANUP_OUTPUT_HALVES = [
    'full',
    'left',
    'right',
] as const;
const SCAN_CLEANUP_ALIGNMENTS = [
    'top-left',
    'top-center',
    'top-right',
    'center-left',
    'center',
    'center-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
] as const;
type TScanCleanupAlignmentValue = typeof SCAN_CLEANUP_ALIGNMENTS[number];

function decodePageMapEntries(value: unknown, label: string) {
    if (!isRecord(value)) {
        throw new Error(`invalid scan-cleanup ${label}`);
    }
    const entries = Object.entries(value);
    if (entries.length > SCAN_CLEANUP_INPUT_MAX_PAGES) {
        throw new Error(`too many scan-cleanup ${label}`);
    }
    return entries.map(([
        key,
        item,
    ]) => ({
        item,
        key,
        pageNumber: decodeScanCleanupPageKey(key, `${label} page number`),
    }));
}

function decodeOutputMap<T>(
    value: unknown,
    decode: (item: unknown, label: string) => T,
    label: string,
): Partial<Record<typeof SCAN_CLEANUP_OUTPUT_HALVES[number], T>> {
    if (value === undefined) {
        return {};
    }
    if (!isRecord(value)) throw new Error(`invalid scan-cleanup ${label}s`);
    const entries = Object.entries(value);
    if (entries.some(([half]) => !SCAN_CLEANUP_OUTPUT_HALVES.includes(half as typeof SCAN_CLEANUP_OUTPUT_HALVES[number]))) {
        throw new Error(`invalid scan-cleanup ${label} half`);
    }
    return Object.fromEntries(entries.map(([
        half,
        item,
    ]) => [
        half,
        decode(item, `${label} ${half}`),
    ]));
}

export function decodeScanCleanupPageOverrides(
    value: unknown,
    budget = createScanCleanupInputBudget(),
) {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup page overrides');
    const entries = Object.entries(value);
    consumeScanCleanupPages(budget, entries.length, 'page overrides');
    return Object.fromEntries(entries.map(([
        key,
        override,
    ]) => {
        const pageNumber = decodeScanCleanupPageKey(key, 'page override number');
        return [
            String(pageNumber),
            decodePageOverride(override, budget),
        ];
    }));
}

function decodeOptions(options: unknown): IScanCleanupStartRequest['options'] {
    if (!isRecord(options)) throw new Error('invalid scan-cleanup options');
    const binarization = options.binarization ?? 'auto';
    const normalizeIllumination = options.normalizeIllumination ?? true;
    const legacyDespeckle = options.despeckle;
    const despeckleLevel = options.despeckleLevel
        ?? (legacyDespeckle === false ? 'off' : 'normal');
    const autoDewarp = options.autoDewarp ?? false;
    const autoDewarpDepth = options.autoDewarpDepth === undefined
        ? undefined
        : decodeFiniteNumber(options.autoDewarpDepth, 'automatic dewarp depth');
    if (
        ![
            'auto',
            'force-single',
            'force-two-page',
        ].includes(String(options.layoutMode))
        || ![
            'auto',
            'bw',
            'mixed',
            'grayscale',
            'color',
        ].includes(String(options.outputMode))
        || ![
            'auto',
            'otsu',
            'sauvola',
            'wolf',
        ].includes(String(binarization))
        || typeof normalizeIllumination !== 'boolean'
        || typeof options.thickness !== 'number'
        || !Number.isSafeInteger(options.thickness)
        || options.thickness < -5
        || options.thickness > 5
        || typeof options.crop !== 'boolean'
        || typeof options.matchPageSize !== 'boolean'
        || !SCAN_CLEANUP_ALIGNMENTS.includes(String(options.pageAlignment) as TScanCleanupAlignmentValue)
        || (legacyDespeckle !== undefined && typeof legacyDespeckle !== 'boolean')
        || ![
            'off',
            'cautious',
            'normal',
            'aggressive',
        ].includes(String(despeckleLevel))
        || typeof autoDewarp !== 'boolean'
        || (autoDewarpDepth !== undefined
            && (autoDewarpDepth < SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN
                || autoDewarpDepth > SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX))
        || ![
            'ltr',
            'rtl',
        ].includes(String(options.readingOrder))
        || typeof options.skipBlankPages !== 'boolean'
        || typeof options.preserveOriginalQuality !== 'boolean'
    ) throw new Error('invalid scan-cleanup options');
    const marginsMm = decodeMarginsMm(options.marginsMm, 'margins');
    return {
        preserveOriginalQuality: options.preserveOriginalQuality,
        layoutMode: options.layoutMode as IScanCleanupStartRequest['options']['layoutMode'],
        outputMode: options.outputMode as IScanCleanupStartRequest['options']['outputMode'],
        ...(options.binarization === undefined ? {} : {binarization: binarization as NonNullable<IScanCleanupStartRequest['options']['binarization']>}),
        ...(options.normalizeIllumination === undefined ? {} : {normalizeIllumination}),
        thickness: options.thickness,
        crop: options.crop,
        matchPageSize: options.matchPageSize,
        pageAlignment: options.pageAlignment as IScanCleanupStartRequest['options']['pageAlignment'],
        marginsMm,
        ...(options.despeckleLevel === undefined ? {} : {despeckleLevel: despeckleLevel as NonNullable<IScanCleanupStartRequest['options']['despeckleLevel']>}),
        ...(legacyDespeckle === undefined ? {} : {despeckle: legacyDespeckle}),
        ...(options.autoDewarp === undefined ? {} : {autoDewarp}),
        ...(autoDewarpDepth === undefined ? {} : {autoDewarpDepth}),
        readingOrder: options.readingOrder as IScanCleanupStartRequest['options']['readingOrder'],
        skipBlankPages: options.skipBlankPages,
        pageOverrides: decodeScanCleanupPageOverrides(options.pageOverrides),
    };
}

function decodeLayoutByPage(value: unknown) {
    const entries = decodePageMapEntries(value, 'layout classifications');
    if (entries.some(({item}) => !isLayoutClassification(item))) {
        throw new Error('invalid scan-cleanup layout classifications');
    }
    return Object.fromEntries(entries.map(({
        item,
        key,
    }) => [
        key,
        item,
    ])) as TScanCleanupLayoutByPage;
}

export function decodeSourcePageMetadata(value: unknown): IScanCleanupSourcePageMetadata {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup source page metadata');
    const pageNumber = decodeScanCleanupPageNumber(value.pageNumber, 'source page metadata page number');
    const positive = (field: keyof IScanCleanupSourcePageMetadata) => {
        const decoded = Number(value[field]);
        if (!Number.isFinite(decoded) || decoded <= 0) {
            throw new Error('invalid scan-cleanup source page metadata');
        }
        return decoded;
    };
    const xPoints = Number(value.xPoints);
    const yPoints = Number(value.yPoints);
    const rotation = Number(value.rotation);
    if (![
        xPoints,
        yPoints,
        rotation,
    ].every(Number.isFinite)) {
        throw new Error('invalid scan-cleanup source page metadata');
    }
    const dominant = [
        value.dominantImageWidthPx,
        value.dominantImageHeightPx,
        value.dominantImageWidthPoints,
        value.dominantImageHeightPoints,
    ];
    const hasDominant = dominant.every(item => item !== undefined);
    if (!hasDominant && dominant.some(item => item !== undefined)) {
        throw new Error('invalid scan-cleanup source page metadata');
    }
    const decodedDominant = hasDominant
        ? dominant.map(item => Number(item))
        : [];
    if (
        hasDominant
        && (
            !decodedDominant.every(item => Number.isFinite(item) && item > 0)
            || !Number.isSafeInteger(decodedDominant[0])
            || !Number.isSafeInteger(decodedDominant[1])
        )
    ) {
        throw new Error('invalid scan-cleanup source page metadata');
    }
    return {
        pageNumber,
        xPoints,
        yPoints,
        widthPoints: positive('widthPoints'),
        heightPoints: positive('heightPoints'),
        rotation,
        sourceDpi: positive('sourceDpi'),
        ...(hasDominant ? {
            dominantImageWidthPx: decodedDominant[0],
            dominantImageHeightPx: decodedDominant[1],
            dominantImageWidthPoints: decodedDominant[2],
            dominantImageHeightPoints: decodedDominant[3],
        } : {}),
    };
}

function decodeStartRequest(value: unknown): IScanCleanupStartRequest {
    if (!isRecord(value)) {
        throw new Error('invalid scan-cleanup request');
    }
    const sourcePdfPath = decodeBoundedScanCleanupString(
        value.sourcePdfPath,
        'source PDF path',
        SCAN_CLEANUP_INPUT_MAX_PATH_BYTES,
    );
    const outputModeRecommendations = value.outputModeRecommendations === undefined
        ? undefined
        : (() => {
            const entries = decodePageMapEntries(
                value.outputModeRecommendations,
                'output-mode recommendations',
            );
            if (entries.some(({item}) => !isScanCleanupOutputMode(item))) {
                throw new Error('invalid scan-cleanup output-mode recommendations');
            }
            return Object.fromEntries(entries.map(({
                item,
                key,
            }) => [
                key,
                item,
            ])) as NonNullable<IScanCleanupStartRequest['outputModeRecommendations']>;
        })();
    const softAlphaForegroundRecommendations = value.softAlphaForegroundRecommendations === undefined
        ? undefined
        : (() => {
            const entries = decodePageMapEntries(
                value.softAlphaForegroundRecommendations,
                'soft-alpha foreground recommendations',
            );
            if (entries.some(({item}) => typeof item !== 'boolean')) {
                throw new Error('invalid scan-cleanup soft-alpha foreground recommendations');
            }
            return Object.fromEntries(entries.map(({
                item,
                key,
            }) => [
                key,
                item,
            ])) as NonNullable<IScanCleanupStartRequest['softAlphaForegroundRecommendations']>;
        })();
    const sourcePageNumbers = value.sourcePageNumbers === undefined
        ? undefined
        : (() => {
            if (
                !Array.isArray(value.sourcePageNumbers)
                || value.sourcePageNumbers.length === 0
                || value.sourcePageNumbers.length > SCAN_CLEANUP_INPUT_MAX_PAGES
                || new Set(value.sourcePageNumbers).size !== value.sourcePageNumbers.length
            ) {
                throw new Error('invalid scan-cleanup source page numbers');
            }
            return value.sourcePageNumbers.map(pageNumber => decodeScanCleanupPageNumber(
                pageNumber,
                'source page number',
            ));
        })();
    const sourcePageMetadataByPage = value.sourcePageMetadataByPage === undefined
        ? undefined
        : (() => {
            const entries = decodePageMapEntries(
                value.sourcePageMetadataByPage,
                'source page metadata map',
            );
            return Object.fromEntries(entries.map(({
                item: metadata,
                key,
                pageNumber,
            }) => {
                const decoded = decodeSourcePageMetadata(metadata);
                if (decoded.pageNumber !== pageNumber) {
                    throw new Error('invalid scan-cleanup source page metadata map');
                }
                return [
                    key,
                    decoded,
                ];
            }));
        })();
    const pagePlanEvidenceByPage = value.pagePlanEvidenceByPage === undefined
        ? undefined
        : (() => {
            const entries = decodePageMapEntries(
                value.pagePlanEvidenceByPage,
                'page-plan evidence map',
            );
            return Object.fromEntries(entries.map(({
                item: evidence,
                key,
                pageNumber,
            }) => {
                if (
                    !isRecord(evidence)
                    || evidence.pageNumber !== pageNumber
                    || ![
                        0,
                        90,
                        180,
                        270,
                    ].includes(Number(evidence.rotationDegrees))
                    || !isLayoutClassification(evidence.layoutClassification)
                    || !isRecord(evidence.outputs)
                ) {
                    throw new Error('invalid scan-cleanup page-plan evidence map');
                }
                const rotationDegrees = evidence.rotationDegrees as IScanCleanupPagePlanEvidence['rotationDegrees'];
                const automaticSplit = evidence.automaticSplit === undefined
                    ? undefined
                    : (() => {
                        if (!isRecord(evidence.automaticSplit)) {
                            throw new Error('invalid scan-cleanup automatic split');
                        }
                        const xNormalized = decodeNormalizedValue(
                            evidence.automaticSplit.xNormalized,
                            'automatic split x',
                        );
                        if (xNormalized <= 0 || xNormalized >= 1) {
                            throw new Error('invalid scan-cleanup automatic split');
                        }
                        return {
                            xNormalized,
                            rotationDegrees: decodeGeometryRotation(
                                evidence.automaticSplit.rotationDegrees,
                                rotationDegrees,
                                'automatic split',
                            ),
                        };
                    })();
                const outputs = decodeOutputMap(evidence.outputs, (output, label) => {
                    if (!isRecord(output)) {
                        throw new Error(`invalid scan-cleanup ${label}`);
                    }
                    const detectedSkewDegrees = output.detectedSkewDegrees === undefined
                        ? undefined
                        : decodeFiniteNumber(output.detectedSkewDegrees, `${label} skew`);
                    if (
                        detectedSkewDegrees !== undefined
                        && (detectedSkewDegrees < SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES
                            || detectedSkewDegrees > SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES)
                    ) {
                        throw new Error(`invalid scan-cleanup ${label} skew`);
                    }
                    const contentBox = output.contentBox === undefined
                        ? undefined
                        : decodeNormalizedRect(output.contentBox, `${label} content box`, rotationDegrees);
                    const textToneDiagnostics = output.textToneDiagnostics === undefined
                        ? undefined
                        : decodeTextToneEvidence(output.textToneDiagnostics, `${label} text tone`);
                    if (
                        contentBox === undefined
                        && detectedSkewDegrees === undefined
                        && textToneDiagnostics === undefined
                    ) {
                        throw new Error(`invalid scan-cleanup ${label}`);
                    }
                    return {
                        ...(contentBox === undefined ? {} : {contentBox}),
                        ...(detectedSkewDegrees === undefined ? {} : {detectedSkewDegrees}),
                        ...(textToneDiagnostics === undefined ? {} : {textToneDiagnostics}),
                    };
                }, 'automatic page-plan output');
                return [
                    key,
                    {
                        pageNumber,
                        rotationDegrees,
                        layoutClassification: evidence.layoutClassification,
                        ...(automaticSplit === undefined ? {} : {automaticSplit}),
                        outputs,
                    } satisfies IScanCleanupPagePlanEvidence,
                ];
            }));
        })();
    return {
        sourcePdfPath,
        ...decodeOwnerContext(value),
        options: decodeOptions(value.options),
        ...(sourcePageNumbers === undefined ? {} : {sourcePageNumbers}),
        ...(outputModeRecommendations === undefined ? {} : {outputModeRecommendations}),
        ...(softAlphaForegroundRecommendations === undefined
            ? {}
            : {softAlphaForegroundRecommendations}),
        ...(value.layoutByPage === undefined ? {} : {layoutByPage: decodeLayoutByPage(value.layoutByPage)}),
        ...(sourcePageMetadataByPage === undefined ? {} : {sourcePageMetadataByPage}),
        ...(pagePlanEvidenceByPage === undefined ? {} : {pagePlanEvidenceByPage}),
    };
}

function decodePreviewRequest(value: unknown): IScanCleanupPreviewRequest {
    if (
        !isRecord(value)
        || (value.visible !== undefined && typeof value.visible !== 'boolean')
    ) throw new Error('invalid scan-cleanup preview request');
    const requestId = decodeBoundedScanCleanupString(
        value.requestId,
        'preview request id',
        SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    );
    const sourcePdfPath = decodeBoundedScanCleanupString(
        value.sourcePdfPath,
        'preview source PDF path',
        SCAN_CLEANUP_INPUT_MAX_PATH_BYTES,
    );
    const pageNumber = decodeScanCleanupPageNumber(value.pageNumber, 'preview page number');
    const detail = value.detail === undefined
        ? undefined
        : (() => {
            if (
                !isRecord(value.detail)
                || !isRecord(value.detail.viewports)
                || !isScanCleanupOutputMode(value.detail.outputMode)
            ) {
                throw new Error('invalid scan-cleanup detail preview request');
            }
            const halves = [
                'full',
                'left',
                'right',
            ] as const;
            if (
                Object.keys(value.detail.viewports).length === 0
                || Object.keys(value.detail.viewports).some(half => !halves.includes(
                    half as typeof halves[number],
                ))
            ) {
                throw new Error('invalid scan-cleanup detail preview request');
            }
            const viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'] = {};
            for (const half of halves) {
                const encodedViewport = value.detail.viewports[half];
                if (encodedViewport === undefined) continue;
                viewports[half] = decodeNormalizedRect(
                    encodedViewport,
                    'detail preview viewport',
                );
            }
            if (Object.keys(viewports).length === 0) {
                throw new Error('invalid scan-cleanup detail preview request');
            }
            return {
                viewports,
                outputMode: value.detail.outputMode,
            };
        })();
    return {
        requestId,
        sourcePdfPath,
        ...decodeOwnerContext(value),
        pageNumber,
        options: decodeOptions(value.options),
        ...(value.documentPrior === undefined ? {} : {documentPrior: decodeDocumentPrior(value.documentPrior)}),
        ...(value.outputModeRecommendation === undefined
            ? {}
            : {outputModeRecommendation: (() => {
                if (!isScanCleanupOutputMode(value.outputModeRecommendation)) {
                    throw new Error('invalid scan-cleanup preview output-mode recommendation');
                }
                return value.outputModeRecommendation;
            })()}),
        ...(value.softAlphaForegroundRecommendation === undefined
            ? {}
            : (() => {
                if (typeof value.softAlphaForegroundRecommendation !== 'boolean') {
                    throw new Error('invalid scan-cleanup preview soft-alpha foreground recommendation');
                }
                return {softAlphaForegroundRecommendation: value.softAlphaForegroundRecommendation};
            })()),
        ...(value.layoutByPage === undefined ? {} : {layoutByPage: decodeLayoutByPage(value.layoutByPage)}),
        ...(detail === undefined ? {} : {detail}),
        ...(value.visible === undefined ? {} : {visible: value.visible}),
    };
}

function decodeDetectionRequest(value: unknown): IScanCleanupDetectionRequest {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup detection request');
    return {
        sourcePdfPath: decodeBoundedScanCleanupString(
            value.sourcePdfPath,
            'detection source PDF path',
            SCAN_CLEANUP_INPUT_MAX_PATH_BYTES,
        ),
        ...decodeOwnerContext(value),
        options: decodeOptions(value.options),
    };
}

export function decodeDetectionArgs(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 1,
    });
    return [decodeDetectionRequest(args[0])] as [IScanCleanupDetectionRequest];
}

export function decodePreviewArgs(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 1,
    });
    return [decodePreviewRequest(args[0])] as [IScanCleanupPreviewRequest];
}

export function decodeFiniteNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return value;
}

export function decodeStartArgs(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 1,
    });
    return [decodeStartRequest(args[0])] as [IScanCleanupStartRequest];
}
