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
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewRequest,
    IScanCleanupStartRequest,
} from '@contracts/scan-cleanup/ipc';
import {isScanCleanupOutputMode} from '@contracts/scan-cleanup/outputModeGuards';

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
    if (
        !Array.isArray(value)
        || value.length > SCAN_CLEANUP_RETAIN_PAGES_MAX
        || value.some(page => !Number.isSafeInteger(page) || Number(page) < 1)
    ) throw new Error('invalid scan-cleanup retained preview pages');
    return value.map(Number);
}

export function decodePreviewCancelArgs(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 1,
    });
    const value = args[0];
    if (
        !isRecord(value)
        || typeof value.sourcePdfPath !== 'string'
        || value.sourcePdfPath.trim().length === 0
        || (value.invalidateRawCache !== undefined && typeof value.invalidateRawCache !== 'boolean')
    ) throw new Error('invalid scan-cleanup preview cancellation');
    const retainPages = decodeRetainedPages(value.retainPages);
    return [{
        sourcePdfPath: value.sourcePdfPath,
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
    if (typeof jobId !== 'string' || jobId.trim().length === 0) throw new Error('invalid scan-cleanup job id');
    if (!isRecord(ownerValue)) throw new Error('invalid scan-cleanup owner context');
    return [
        jobId,
        decodeOwnerContext(ownerValue),
    ] as [string, ReturnType<typeof decodeOwnerContext>];
}

function decodeOwnerContext(value: Record<string, unknown>) {
    if (
        typeof value.ownerId !== 'string'
        || value.ownerId.trim().length === 0
        || typeof value.documentRevision !== 'string'
        || value.documentRevision.trim().length === 0
    ) throw new Error('invalid scan-cleanup owner context');
    return {
        ownerId: value.ownerId,
        documentRevision: value.documentRevision,
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
    if (!Array.isArray(args[0]) || args[0].some(path => typeof path !== 'string')) {
        throw new Error('invalid scan-cleanup open PDF paths');
    }
    return [args[0].map(path => String(path))] as [string[]];
}

function decodePageOverride(value: unknown): IScanCleanupPageOverride {
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
    const manualZones = decodeManualZones(value.manualZones, rotationDegrees);
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
): IScanCleanupManualZones | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value) || !Array.isArray(value.picture) || !Array.isArray(value.fill)) {
        throw new Error('invalid scan-cleanup manual zones');
    }
    const decodePolygon = (polygon: unknown, label: string) => {
        if (!isRecord(polygon) || !Array.isArray(polygon.points) || polygon.points.length < 3) {
            throw new Error(`invalid scan-cleanup ${label}`);
        }
        return {
            points: polygon.points.map((point, index) => {
                if (!isRecord(point)) throw new Error(`invalid scan-cleanup ${label} point ${index}`);
                return {
                    xNormalized: decodeNormalizedValue(point.xNormalized, `${label} point ${index} x`),
                    yNormalized: decodeNormalizedValue(point.yNormalized, `${label} point ${index} y`),
                };
            }),
            rotationDegrees: decodeGeometryRotation(polygon.rotationDegrees, rotationDegrees, label),
        };
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

function decodePageOverrides(value: unknown) {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup page overrides');
    const entries = Object.entries(value);
    if (entries.length > 100_000) throw new Error('too many scan-cleanup page overrides');
    return Object.fromEntries(entries.map(([
        key,
        override,
    ]) => {
        const pageNumber = Number(key);
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
            throw new Error('invalid scan-cleanup page override number');
        }
        return [
            String(pageNumber),
            decodePageOverride(override),
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
        pageOverrides: decodePageOverrides(options.pageOverrides),
    };
}

function decodeLayoutByPage(value: unknown) {
    if (
        !isRecord(value)
        || Object.entries(value).some(([
            pageNumber,
            layout,
        ]) => !/^[1-9]\d*$/u.test(pageNumber) || !isLayoutClassification(layout))
    ) {
        throw new Error('invalid scan-cleanup layout classifications');
    }
    return value as TScanCleanupLayoutByPage;
}

function decodeStartRequest(value: unknown): IScanCleanupStartRequest {
    if (!isRecord(value) || typeof value.sourcePdfPath !== 'string' || value.sourcePdfPath.trim().length === 0) {
        throw new Error('invalid scan-cleanup request');
    }
    const outputModeRecommendations = value.outputModeRecommendations === undefined
        ? undefined
        : (() => {
            if (
                !isRecord(value.outputModeRecommendations)
                || Object.entries(value.outputModeRecommendations).some(([
                    pageNumber,
                    mode,
                ]) => !/^[1-9]\d*$/u.test(pageNumber) || !isScanCleanupOutputMode(mode))
            ) {
                throw new Error('invalid scan-cleanup output-mode recommendations');
            }
            return value.outputModeRecommendations as NonNullable<
                IScanCleanupStartRequest['outputModeRecommendations']
            >;
        })();
    const sourcePageNumbers = value.sourcePageNumbers === undefined
        ? undefined
        : (() => {
            if (
                !Array.isArray(value.sourcePageNumbers)
                || value.sourcePageNumbers.length === 0
                || value.sourcePageNumbers.some(pageNumber => !Number.isSafeInteger(pageNumber) || Number(pageNumber) < 1)
                || new Set(value.sourcePageNumbers).size !== value.sourcePageNumbers.length
            ) {
                throw new Error('invalid scan-cleanup source page numbers');
            }
            return value.sourcePageNumbers.map(Number);
        })();
    return {
        sourcePdfPath: value.sourcePdfPath,
        ...decodeOwnerContext(value),
        options: decodeOptions(value.options),
        ...(sourcePageNumbers === undefined ? {} : {sourcePageNumbers}),
        ...(outputModeRecommendations === undefined ? {} : {outputModeRecommendations}),
        ...(value.layoutByPage === undefined ? {} : {layoutByPage: decodeLayoutByPage(value.layoutByPage)}),
    };
}

function decodePreviewRequest(value: unknown): IScanCleanupPreviewRequest {
    if (
        !isRecord(value)
        || typeof value.sourcePdfPath !== 'string'
        || value.sourcePdfPath.trim().length === 0
        || !Number.isSafeInteger(value.pageNumber)
        || Number(value.pageNumber) < 1
        || (value.visible !== undefined && typeof value.visible !== 'boolean')
    ) throw new Error('invalid scan-cleanup preview request');
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
        sourcePdfPath: value.sourcePdfPath,
        ...decodeOwnerContext(value),
        pageNumber: Number(value.pageNumber),
        options: decodeOptions(value.options),
        ...(value.documentPrior === undefined ? {} : {documentPrior: decodeDocumentPrior(value.documentPrior)}),
        ...(value.layoutByPage === undefined ? {} : {layoutByPage: decodeLayoutByPage(value.layoutByPage)}),
        ...(detail === undefined ? {} : {detail}),
        ...(value.visible === undefined ? {} : {visible: value.visible}),
    };
}

function decodeDetectionRequest(value: unknown): IScanCleanupDetectionRequest {
    if (
        !isRecord(value)
        || typeof value.sourcePdfPath !== 'string'
        || value.sourcePdfPath.trim().length === 0
    ) throw new Error('invalid scan-cleanup detection request');
    return {
        sourcePdfPath: value.sourcePdfPath,
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
