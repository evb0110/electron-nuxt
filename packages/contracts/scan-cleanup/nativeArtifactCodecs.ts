import type {
    IScanCleanupContentDiagnostics,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewPageMetadata,
} from '@contracts/scan-cleanup/ipc';
import type {
    IScanCleanupAppliedMargins,
    IScanCleanupPixelPoint,
} from '@contracts/scan-cleanup/geometry';
import {
    SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
    type INativeScanCleanupAnalysisOutputV3,
    type INativeScanCleanupDewarpModelV3,
    type INativeScanCleanupOutputMetadataV3,
    type INativeScanCleanupPageMetadataV3,
    type INativeScanCleanupReusableGeometryV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {isRecord} from '@contracts/runtimeGuards';

const MAX_PAGE_OUTPUTS = 2;
const MAX_WARNINGS = 256;
const MAX_WARNING_LENGTH = 4_096;
const MAX_GEOMETRY_POINTS = 65_536;
const MAX_DIAGNOSTIC_ITEMS = 4_096;
const MAX_PAGE_METADATA_JSON_LENGTH = 2 * 1024 * 1024;
const MAX_OUTPUT_METADATA_JSON_LENGTH = 16 * 1024 * 1024;

const HALVES = [
    'full',
    'left',
    'right',
] as const;
const LAYOUTS = [
    'single-uncut-page',
    'page-with-offcut',
    'two-page-spread',
] as const;
const ROTATIONS = [
    0,
    90,
    180,
    270,
] as const;
const OUTPUT_MODES = [
    'bw',
    'mixed',
    'grayscale',
    'color',
] as const;
const BINARIZATION_MODES = [
    'auto',
    'otsu',
    'sauvola',
    'wolf',
] as const;

export class InvalidScanCleanupNativeArtifactError extends Error {
    // Stable typed-error discriminator consumed across process boundaries.
    // fallow-ignore-next-line unused-class-member
    readonly code = 'native-failure' as const;
    readonly artifact: 'page metadata' | 'output metadata';

    constructor(artifact: InvalidScanCleanupNativeArtifactError['artifact'], detail: string) {
        super(`Invalid evb-scan-cleanup ${artifact}: ${detail}`);
        this.name = 'InvalidScanCleanupNativeArtifactError';
        this.artifact = artifact;
    }
}

export interface INativeScanCleanupAnalysisArtifactOutputV3 extends INativeScanCleanupAnalysisOutputV3 {
    appliedMargins?: IScanCleanupAppliedMargins;
    contentDiagnostics?: IScanCleanupContentDiagnostics;
}

export interface INativeScanCleanupPageArtifactMetadataV3 extends INativeScanCleanupPageMetadataV3 {
    sourcePageIndex?: number;
    outputs?: INativeScanCleanupAnalysisArtifactOutputV3[];
    tier1Verdict?: INativeScanCleanupPageMetadataV3['layoutClassification'];
    reconciled?: boolean;
    clusterAgreement?: number;
}

export type TNativeScanCleanupPreviewPageArtifactMetadataV3 = IScanCleanupPreviewPageMetadata
    & Omit<INativeScanCleanupPageArtifactMetadataV3, 'outputs'>
    & {outputs?: Array<INativeScanCleanupAnalysisArtifactOutputV3 & {
        appliedMargins: IScanCleanupAppliedMargins;
        contentBox: IScanCleanupPreviewMetadata['contentBox'];
    }>};

export type TNativeScanCleanupPreviewOutputArtifactMetadataV3 = IScanCleanupPreviewMetadata
    & INativeScanCleanupOutputMetadataV3
    & INativeScanCleanupReusableGeometryV3
    & {dewarpModel?: INativeScanCleanupDewarpModelV3 | null;};

type TArtifact = InvalidScanCleanupNativeArtifactError['artifact'];

function fail(artifact: TArtifact, detail: string): never {
    throw new InvalidScanCleanupNativeArtifactError(artifact, detail);
}

function decoded<T>(source: Record<string, unknown>): T {
    return source as T;
}

function record(value: unknown, artifact: TArtifact, label: string): Record<string, unknown> {
    if (!isRecord(value)) fail(artifact, `${label} must be an object`);
    return value;
}

function finite(value: unknown, artifact: TArtifact, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(artifact, `${label} must be finite`);
    return value;
}

function integer(value: unknown, artifact: TArtifact, label: string, min = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        fail(artifact, `${label} must be a safe integer >= ${String(min)}`);
    }
    return value;
}

function unit(value: unknown, artifact: TArtifact, label: string): number {
    const result = finite(value, artifact, label);
    if (result < 0 || result > 1) fail(artifact, `${label} must be between 0 and 1`);
    return result;
}

function oneOf<T>(value: unknown, values: readonly T[], artifact: TArtifact, label: string): T {
    if (!values.includes(value as T)) fail(artifact, `${label} has an unknown discriminant`);
    return value as T;
}

function optionalBoolean(source: Record<string, unknown>, key: string, artifact: TArtifact) {
    if (source[key] !== undefined && typeof source[key] !== 'boolean') fail(artifact, `${key} must be boolean`);
}

function nullableFinite(value: unknown, artifact: TArtifact, label: string) {
    if (value !== null) finite(value, artifact, label);
}

function pixelPoint(value: unknown, artifact: TArtifact, label: string): IScanCleanupPixelPoint {
    const source = record(value, artifact, label);
    return {
        x: finite(source.x, artifact, `${label}.x`),
        y: finite(source.y, artifact, `${label}.y`),
    };
}

function pixelRect(value: unknown, artifact: TArtifact, label: string) {
    const source = record(value, artifact, label);
    const result = {
        xPx: finite(source.xPx, artifact, `${label}.xPx`),
        yPx: finite(source.yPx, artifact, `${label}.yPx`),
        widthPx: finite(source.widthPx, artifact, `${label}.widthPx`),
        heightPx: finite(source.heightPx, artifact, `${label}.heightPx`),
    };
    if (result.widthPx < 0 || result.heightPx < 0) fail(artifact, `${label} dimensions must be non-negative`);
    return result;
}

function margins(value: unknown, artifact: TArtifact, label: string) {
    const source = record(value, artifact, label);
    for (const key of [
        'leftPx',
        'topPx',
        'rightPx',
        'bottomPx',
    ] as const) {
        if (finite(source[key], artifact, `${label}.${key}`) < 0) fail(artifact, `${label}.${key} must be non-negative`);
    }
}

function boundedPoints(value: unknown, artifact: TArtifact, label: string, minimum: number) {
    if (!Array.isArray(value) || value.length < minimum || value.length > MAX_GEOMETRY_POINTS) {
        fail(artifact, `${label} has an invalid point count`);
    }
    value.forEach((point, index) => pixelPoint(point, artifact, `${label}[${String(index)}]`));
}

function splitSeam(value: unknown, artifact: TArtifact, label: string) {
    const source = record(value, artifact, label);
    boundedPoints(source.points, artifact, `${label}.points`, 2);
}

function affine(value: unknown, artifact: TArtifact, label: string) {
    if (value === null) {
        return;
    }
    const source = record(value, artifact, label);
    if (!Array.isArray(source.matrix) || source.matrix.length !== 3) fail(artifact, `${label}.matrix must be 3x3`);
    source.matrix.forEach((row, rowIndex) => {
        if (!Array.isArray(row) || row.length !== 3) fail(artifact, `${label}.matrix must be 3x3`);
        row.forEach((item, columnIndex) => finite(
            item,
            artifact,
            `${label}.matrix[${String(rowIndex)}][${String(columnIndex)}]`,
        ));
    });
}

function textToneDiagnostics(value: unknown, artifact: TArtifact, label: string) {
    const source = record(value, artifact, label);
    if (typeof source.applied !== 'boolean') fail(artifact, `${label}.applied must be boolean`);
    oneOf(source.rule, [
        'applied',
        'picture-evidence',
        'insufficient-text',
        'tonal-mass-outside-text',
        'already-dark',
    ] as const, artifact, `${label}.rule`);
    integer(source.textLineCount, artifact, `${label}.textLineCount`);
    integer(source.textInkPixels, artifact, `${label}.textInkPixels`);
    for (const key of [
        'pictureFraction',
        'outsideMidtoneFraction',
        'outsideMidtoneLargestComponentFraction',
        'outsideMidtoneLargestComponentWidthFraction',
        'outsideMidtoneLargestComponentHeightFraction',
    ] as const) unit(source[key], artifact, `${label}.${key}`);
    if (source.inkAnchor !== null) {
        const inkAnchor = integer(source.inkAnchor, artifact, `${label}.inkAnchor`);
        if (inkAnchor > 255) fail(artifact, `${label}.inkAnchor must be <= 255`);
    }
    nullableFinite(source.blackPoint, artifact, `${label}.blackPoint`);
    nullableFinite(source.slope, artifact, `${label}.slope`);
    if (source.applied !== (source.rule === 'applied')) fail(artifact, `${label} applied/rule mismatch`);
}

function binarizationDiagnostics(value: unknown, artifact: TArtifact, label: string) {
    const source = record(value, artifact, label);
    oneOf(source.route, BINARIZATION_MODES, artifact, `${label}.route`);
    for (const key of [
        'robustContrast',
        'illuminationDeviation',
        'edgeDensity',
        'estimatedStrokeWidthPx',
        'darkBorderCoverage',
        'otsuAdaptiveAgreement',
    ] as const) finite(source[key], artifact, `${label}.${key}`);
}

function contentDiagnostics(value: unknown, artifact: TArtifact, label: string) {
    const source = record(value, artifact, label);
    const confidence = record(source.sideConfidence, artifact, `${label}.sideConfidence`);
    for (const key of [
        'left',
        'top',
        'right',
        'bottom',
    ] as const) unit(confidence[key], artifact, `${label}.sideConfidence.${key}`);
    const textMask = record(source.textMask, artifact, `${label}.textMask`);
    integer(textMask.analysisWidthPx, artifact, `${label}.textMask.analysisWidthPx`, 1);
    integer(textMask.analysisHeightPx, artifact, `${label}.textMask.analysisHeightPx`, 1);
    integer(textMask.inkPixels, artifact, `${label}.textMask.inkPixels`);
    integer(textMask.lineCount, artifact, `${label}.textMask.lineCount`);
    if (textMask.bounds !== undefined) pixelRect(textMask.bounds, artifact, `${label}.textMask.bounds`);
    const block = (item: unknown, itemLabel: string) => {
        const candidate = record(item, artifact, itemLabel);
        pixelRect(candidate.bounds, artifact, `${itemLabel}.bounds`);
        integer(candidate.pictureMaskOverlapPixels, artifact, `${itemLabel}.pictureMaskOverlapPixels`);
        for (const key of [
            'headingEvidence',
            'grayscaleEvidence',
        ] as const) if (typeof candidate[key] !== 'boolean') fail(artifact, `${itemLabel}.${key} must be boolean`);
        optionalBoolean(candidate, 'textEvidence', artifact);
    };
    if (source.acceptedTrims !== undefined) {
        if (!Array.isArray(source.acceptedTrims) || source.acceptedTrims.length > MAX_DIAGNOSTIC_ITEMS) {
            fail(artifact, `${label}.acceptedTrims is too large`);
        }
        source.acceptedTrims.forEach((item, index) => {
            const trimLabel = `${label}.acceptedTrims[${String(index)}]`;
            const trim = record(item, artifact, trimLabel);
            oneOf(trim.side, [
                'left',
                'top',
                'right',
                'bottom',
            ] as const, artifact, `${trimLabel}.side`);
            integer(trim.iteration, artifact, `${trimLabel}.iteration`);
            unit(trim.score, artifact, `${trimLabel}.score`);
            unit(trim.threshold, artifact, `${trimLabel}.threshold`);
            finite(trim.contentDistanceSum, artifact, `${trimLabel}.contentDistanceSum`);
            finite(trim.garbageDistanceSum, artifact, `${trimLabel}.garbageDistanceSum`);
            if (!Array.isArray(trim.removedBlocks) || trim.removedBlocks.length > MAX_DIAGNOSTIC_ITEMS) {
                fail(artifact, `${trimLabel}.removedBlocks is too large`);
            }
            trim.removedBlocks.forEach((item, blockIndex) => block(item, `${trimLabel}.removedBlocks[${String(blockIndex)}]`));
        });
    }
    if (source.protectedBlocks !== undefined) {
        if (!Array.isArray(source.protectedBlocks) || source.protectedBlocks.length > MAX_DIAGNOSTIC_ITEMS) {
            fail(artifact, `${label}.protectedBlocks is too large`);
        }
        source.protectedBlocks.forEach((item, index) => block(item, `${label}.protectedBlocks[${String(index)}]`));
    }
}

function outputModeDiagnostics(value: unknown, artifact: TArtifact, label: string) {
    const source = record(value, artifact, label);
    oneOf(source.rule, [
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
    ] as const, artifact, `${label}.rule`);
    for (const key of [
        'fallbackUsed',
        'significantColor',
        'significantPicture',
        'coherentOutsideTonalRegion',
        'destructiveModeTonalVeto',
        'bilevelFidelityVeto',
    ] as const) if (typeof source[key] !== 'boolean') fail(artifact, `${label}.${key} must be boolean`);
    for (const key of [
        'analysisWidth',
        'analysisHeight',
        'otsuThreshold',
        'largestColorComponentPixels',
        'textLineCount',
    ] as const) integer(source[key], artifact, `${label}.${key}`);
    for (const key of [
        'darkMean',
        'lightMean',
        'midtoneLower',
        'midtoneUpper',
        'p01',
        'p50',
        'p99',
        'bimodality',
        'midtoneFraction',
        'relativeMidtoneFraction',
        'modeDistance',
        'inkFraction',
        'edgeFraction',
        'robustLuminanceRange',
        'coloredFraction',
        'meanSaturation',
        'pictureFraction',
        'pictureGateMargin',
        'tonalMidtoneGateMargin',
        'strongBimodalityGateMargin',
        'confidentTextBimodalityMargin',
        'confidentTextModeDistanceMargin',
        'confidentTextMidtoneMargin',
        'denseTextLineMargin',
        'denseTextBimodalityMargin',
        'denseTextModeDistanceMargin',
        'denseTextMidtoneMargin',
        'outsideTonalFraction',
        'outsideTonalLargestComponentFraction',
        'outsideTonalLargestComponentWidthFraction',
        'outsideTonalLargestComponentHeightFraction',
        'sourceDpi',
        'analysisDpi',
        'calibratedSourceStrokeWidthPx',
        'calibratedSourceXHeightPx',
        'softEdgeToInkRatio',
    ] as const) finite(source[key], artifact, `${label}.${key}`);
}

function splitDiagnostics(value: unknown, artifact: TArtifact, label: string) {
    const source = record(value, artifact, label);
    for (const key of [
        'leftInkPixels',
        'rightInkPixels',
        'independentSpreadCues',
    ] as const) integer(source[key], artifact, `${label}.${key}`);
    for (const key of [
        'analysisDpi',
        'deskewAngleDegrees',
        'deskewConfidence',
        'cutterSlope',
        'leftDeskewAngleDegrees',
        'rightDeskewAngleDegrees',
        'leftDeskewConfidence',
        'rightDeskewConfidence',
        'whitespaceX',
        'foldX',
        'decisionX',
        'whitespaceScore',
        'bilateralScore',
        'leftPageScore',
        'rightPageScore',
        'leftContentScore',
        'rightContentScore',
        'leftSurfaceScore',
        'rightSurfaceScore',
        'outerMarginScore',
        'gutterScore',
        'agreementScore',
        'foldScore',
        'gutterDarknessScore',
        'softGutterScore',
        'softGutterCoverage',
        'softGutterContinuity',
        'softGutterMeanDepression',
        'sparseGutterScore',
        'sparseGutterCoverage',
        'sparseGutterContinuity',
        'sparseGutterMeanDepression',
        'aspectRatio',
        'aspectSpreadScore',
        'aspectSingleScore',
        'offcutBoundaryScore',
        'offcutEmptyScore',
        'offcutWidthScore',
        'offcutNoTextRowsScore',
        'alternativeProduct',
        'evidenceProduct',
    ] as const) finite(source[key], artifact, `${label}.${key}`);
    for (const key of [
        'whitespaceGatePassed',
        'centralPositionGatePassed',
        'bilateralGatePassed',
        'outerMarginGatePassed',
        'gutterGatePassed',
        'independentGutterGatePassed',
        'aspectSupportGatePassed',
        'evidenceAgreementGatePassed',
        'sparseSpreadRecovered',
        'abstained',
    ] as const) if (typeof source[key] !== 'boolean') fail(artifact, `${label}.${key} must be boolean`);
}

function documentPrior(value: unknown, artifact: TArtifact, label: string) {
    const source = record(value, artifact, label);
    oneOf(source.dominantLayout, LAYOUTS, artifact, `${label}.dominantLayout`);
    nullableFinite(source.cutterRatioMedian, artifact, `${label}.cutterRatioMedian`);
    const dimensions = record(source.clusterDims, artifact, `${label}.clusterDims`);
    if (finite(dimensions.widthPx, artifact, `${label}.clusterDims.widthPx`) <= 0
        || finite(dimensions.heightPx, artifact, `${label}.clusterDims.heightPx`) <= 0) {
        fail(artifact, `${label}.clusterDims must be positive`);
    }
    unit(source.agreementStrength, artifact, `${label}.agreementStrength`);
}

function analysisOutput(value: unknown, artifact: TArtifact, label: string) {
    const source = record(value, artifact, label);
    oneOf(source.half, HALVES, artifact, `${label}.half`);
    pixelRect(source.sourceRegion, artifact, `${label}.sourceRegion`);
    if (source.contentBox !== undefined && source.contentBox !== null) pixelRect(source.contentBox, artifact, `${label}.contentBox`);
    if (source.contentDiagnostics !== undefined) contentDiagnostics(source.contentDiagnostics, artifact, `${label}.contentDiagnostics`);
    if (source.textToneDiagnostics !== undefined) textToneDiagnostics(source.textToneDiagnostics, artifact, `${label}.textToneDiagnostics`);
    pixelRect(source.cropRect, artifact, `${label}.cropRect`);
    if (source.appliedMargins !== undefined) margins(source.appliedMargins, artifact, `${label}.appliedMargins`);
    integer(source.inputWidthPx, artifact, `${label}.inputWidthPx`, 1);
    integer(source.inputHeightPx, artifact, `${label}.inputHeightPx`, 1);
}

function validateVersion(source: Record<string, unknown>, artifact: TArtifact) {
    if (source.version !== undefined && source.version !== SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION) {
        fail(artifact, `unsupported protocol version ${String(source.version)}`);
    }
}

function parseJson(text: string, artifact: TArtifact, maximumLength: number): unknown {
    if (text.length > maximumLength) fail(artifact, 'JSON exceeds the artifact size limit');
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return fail(artifact, 'JSON is malformed');
    }
}

export function decodeNativeScanCleanupPageMetadata(
    value: unknown,
): INativeScanCleanupPageArtifactMetadataV3 {
    const artifact = 'page metadata' as const;
    const decodedSource = record(value, artifact, 'root');
    // Early protocol-v3 analysis artifacts predate page/document canvas
    // reporting. They were page-scoped by definition; preserve that one
    // unambiguous compatibility default while rejecting unknown values.
    const source = decodedSource.canvasScope === undefined
        ? {
            ...decodedSource,
            canvasScope: 'page',
        }
        : decodedSource;
    validateVersion(source, artifact);
    if (source.sourcePageIndex !== undefined) integer(source.sourcePageIndex, artifact, 'sourcePageIndex');
    oneOf(source.layoutClassification, LAYOUTS, artifact, 'layoutClassification');
    if (source.layoutConfidence !== undefined) unit(source.layoutConfidence, artifact, 'layoutConfidence');
    nullableFinite(source.cutterXPx, artifact, 'cutterXPx');
    if (source.splitSeam !== undefined) splitSeam(source.splitSeam, artifact, 'splitSeam');
    optionalBoolean(source, 'splitAbstained', artifact);
    oneOf(source.rotationDegrees, ROTATIONS, artifact, 'rotationDegrees');
    oneOf(source.canvasScope, [
        'page',
        'document',
    ] as const, artifact, 'canvasScope');
    if (typeof source.excluded !== 'boolean') fail(artifact, 'excluded must be boolean');
    integer(source.blankOutputsSkipped, artifact, 'blankOutputsSkipped');
    const outputCount = integer(source.outputCount, artifact, 'outputCount');
    if (outputCount > MAX_PAGE_OUTPUTS) fail(artifact, 'outputCount exceeds the protocol limit');
    if (source.outputs !== undefined) {
        if (!Array.isArray(source.outputs) || source.outputs.length > MAX_PAGE_OUTPUTS) fail(artifact, 'outputs exceeds the protocol limit');
        source.outputs.forEach((item, index) => analysisOutput(item, artifact, `outputs[${String(index)}]`));
        if (source.outputs.length !== outputCount) fail(artifact, 'outputs length does not match outputCount');
        const halves = source.outputs.map(item => (item as Record<string, unknown>).half);
        if (new Set(halves).size !== halves.length) fail(artifact, 'outputs contains duplicate halves');
    }
    if (source.recommendedOutputMode !== undefined) oneOf(source.recommendedOutputMode, OUTPUT_MODES, artifact, 'recommendedOutputMode');
    if (source.recommendedOutputModeConfidence !== undefined) unit(source.recommendedOutputModeConfidence, artifact, 'recommendedOutputModeConfidence');
    if (source.recommendedOutputModeReason !== undefined) oneOf(source.recommendedOutputModeReason, [
        'blank',
        'color-chroma',
        'text-with-pictures',
        'continuous-tone',
        'bimodal-text',
        'uncertain-tonal',
    ] as const, artifact, 'recommendedOutputModeReason');
    optionalBoolean(source, 'softAlphaForegroundRecommendation', artifact);
    if (source.outputModeDiagnostics !== undefined) outputModeDiagnostics(source.outputModeDiagnostics, artifact, 'outputModeDiagnostics');
    if (source.splitDiagnostics !== undefined) splitDiagnostics(source.splitDiagnostics, artifact, 'splitDiagnostics');
    if (source.tier1Verdict !== undefined) oneOf(source.tier1Verdict, LAYOUTS, artifact, 'tier1Verdict');
    optionalBoolean(source, 'reconciled', artifact);
    if (source.clusterAgreement !== undefined) {
        const agreement = finite(source.clusterAgreement, artifact, 'clusterAgreement');
        if (agreement < -1 || agreement > 1) fail(artifact, 'clusterAgreement must be between -1 and 1');
    }
    if (source.documentPrior !== undefined) documentPrior(source.documentPrior, artifact, 'documentPrior');
    if (source.textAxis !== undefined) {
        const axis = record(source.textAxis, artifact, 'textAxis');
        if (typeof axis.sideways !== 'boolean') fail(artifact, 'textAxis.sideways must be boolean');
        unit(axis.confidence, artifact, 'textAxis.confidence');
    }
    return decoded<INativeScanCleanupPageArtifactMetadataV3>(source);
}

export function decodeNativeScanCleanupPageMetadataJson(text: string) {
    return decodeNativeScanCleanupPageMetadata(parseJson(
        text,
        'page metadata',
        MAX_PAGE_METADATA_JSON_LENGTH,
    ));
}

export function decodeNativeScanCleanupPreviewPageMetadataJson(
    text: string,
): TNativeScanCleanupPreviewPageArtifactMetadataV3 {
    const metadata = decodeNativeScanCleanupPageMetadataJson(text);
    (metadata.outputs ?? []).forEach((output, index) => {
        if (output.appliedMargins === undefined) fail('page metadata', `outputs[${String(index)}].appliedMargins is required for preview`);
        if (!Object.hasOwn(output, 'contentBox')) fail('page metadata', `outputs[${String(index)}].contentBox is required for preview`);
    });
    return {
        ...metadata,
        tier1Verdict: metadata.tier1Verdict ?? metadata.layoutClassification,
        reconciled: metadata.reconciled === true,
        clusterAgreement: metadata.clusterAgreement ?? 0,
    } as TNativeScanCleanupPreviewPageArtifactMetadataV3;
}

function validateOutputOptionals(source: Record<string, unknown>, artifact: TArtifact) {
    if (source.sourcePageIndex !== undefined) integer(source.sourcePageIndex, artifact, 'sourcePageIndex');
    if (source.half !== undefined) oneOf(source.half, HALVES, artifact, 'half');
    if (source.sourceRegion !== undefined) pixelRect(source.sourceRegion, artifact, 'sourceRegion');
    if (source.cropRect !== undefined) pixelRect(source.cropRect, artifact, 'cropRect');
    if (source.contentBox !== undefined && source.contentBox !== null) pixelRect(source.contentBox, artifact, 'contentBox');
    if (source.contentDiagnostics !== undefined) contentDiagnostics(source.contentDiagnostics, artifact, 'contentDiagnostics');
    if (source.appliedMargins !== undefined) margins(source.appliedMargins, artifact, 'appliedMargins');
    if (source.splitSeam !== undefined) splitSeam(source.splitSeam, artifact, 'splitSeam');
    if (source.splitGeometry !== undefined) {
        if (!Array.isArray(source.splitGeometry) || source.splitGeometry.length > MAX_PAGE_OUTPUTS) fail(artifact, 'splitGeometry exceeds the protocol limit');
        source.splitGeometry.forEach((polygon, index) => {
            const candidate = record(polygon, artifact, `splitGeometry[${String(index)}]`);
            boundedPoints(candidate.points, artifact, `splitGeometry[${String(index)}].points`, 3);
        });
    }
    for (const key of [
        'inputWidthPx',
        'inputHeightPx',
        'matchedCanvasTargetWidthPx',
        'matchedCanvasTargetHeightPx',
        'matchedCanvasContentWidthPx',
        'matchedCanvasContentHeightPx',
        'resamplePasses',
    ] as const) if (source[key] !== undefined && source[key] !== null) integer(source[key], artifact, key, key === 'resamplePasses' ? 0 : 1);
    for (const key of [
        'detectedSkewDegrees',
        'skewConfidence',
        'cutterXPx',
        'cropX',
        'cropY',
    ] as const) if (source[key] !== undefined && source[key] !== null) finite(source[key], artifact, key);
    if (source.layoutConfidence !== undefined) unit(source.layoutConfidence, artifact, 'layoutConfidence');
    if (source.dewarpConfidence !== undefined && source.dewarpConfidence !== null) unit(source.dewarpConfidence, artifact, 'dewarpConfidence');
    for (const key of [
        'layeredBackgroundDpi',
        'layeredForegroundDpi',
        'renderDpi',
        'sourceDpi',
        'requestedRenderDpi',
        'matchedCanvasTargetWidthPoints',
        'matchedCanvasTargetHeightPoints',
        'paperHeight',
    ] as const) if (source[key] !== undefined && source[key] !== null && finite(source[key], artifact, key) <= 0) fail(artifact, `${key} must be positive`);
    for (const key of [
        'manualSkew',
        'bilevelWritten',
        'layeredWritten',
        'trustedMrcBackgroundPreserved',
        'trustedSelectionApplied',
        'illuminationNormalized',
        'despeckleFallback',
        'splitAbstained',
        'uniformCanvas',
        'canvasOverflow',
        'rasterScaleLimited',
        'matchedInMemory',
    ] as const) optionalBoolean(source, key, artifact);
    if (source.layeredForegroundKind !== undefined) oneOf(source.layeredForegroundKind, [
        'stencil',
        'soft-alpha',
        'source-mrc',
    ] as const, artifact, 'layeredForegroundKind');
    if (source.outputMode !== undefined) oneOf(source.outputMode, OUTPUT_MODES, artifact, 'outputMode');
    if (source.binarizationMode !== undefined && source.binarizationMode !== null) oneOf(source.binarizationMode, BINARIZATION_MODES, artifact, 'binarizationMode');
    if (source.binarizationDiagnostics !== undefined && source.binarizationDiagnostics !== null) binarizationDiagnostics(source.binarizationDiagnostics, artifact, 'binarizationDiagnostics');
    if (source.textToneDiagnostics !== undefined) textToneDiagnostics(source.textToneDiagnostics, artifact, 'textToneDiagnostics');
    if (source.pdfImagePlacement !== undefined) {
        const placement = record(source.pdfImagePlacement, artifact, 'pdfImagePlacement');
        for (const key of [
            'xPoints',
            'yPoints',
        ] as const) finite(placement[key], artifact, `pdfImagePlacement.${key}`);
        if (finite(placement.widthPoints, artifact, 'pdfImagePlacement.widthPoints') <= 0
            || finite(placement.heightPoints, artifact, 'pdfImagePlacement.heightPoints') <= 0
            || finite(placement.xPoints, artifact, 'pdfImagePlacement.xPoints') < 0
            || finite(placement.yPoints, artifact, 'pdfImagePlacement.yPoints') < 0) {
            fail(artifact, 'pdfImagePlacement must have a positive extent and non-negative origin');
        }
    }
    if (source.renderRegion !== undefined) pixelRect(source.renderRegion, artifact, 'renderRegion');
    if (source.canvasPolicy !== undefined) oneOf(source.canvasPolicy, [
        'intrinsic',
        'strict-maximum',
    ] as const, artifact, 'canvasPolicy');
    if (source.canvasScope !== undefined) oneOf(source.canvasScope, [
        'page',
        'document',
    ] as const, artifact, 'canvasScope');
    if (source.inverseTransform !== undefined) affine(source.inverseTransform, artifact, 'inverseTransform');
    if (source.dewarpModel !== undefined && source.dewarpModel !== null) {
        const model = record(source.dewarpModel, artifact, 'dewarpModel');
        boundedPoints(model.topCurve, artifact, 'dewarpModel.topCurve', 2);
        boundedPoints(model.bottomCurve, artifact, 'dewarpModel.bottomCurve', 2);
        finite(model.depth, artifact, 'dewarpModel.depth');
    }
    if (source.dewarpMapping !== undefined && source.dewarpMapping !== null) {
        const mapping = record(source.dewarpMapping, artifact, 'dewarpMapping');
        const columns = integer(mapping.columns, artifact, 'dewarpMapping.columns', 2);
        const rows = integer(mapping.rows, artifact, 'dewarpMapping.rows', 2);
        const pointCount = columns * rows;
        if (!Number.isSafeInteger(pointCount) || pointCount > MAX_GEOMETRY_POINTS) fail(artifact, 'dewarpMapping grid exceeds the protocol limit');
        pixelPoint(mapping.outputOrigin, artifact, 'dewarpMapping.outputOrigin');
        integer(mapping.outputWidth, artifact, 'dewarpMapping.outputWidth', 1);
        integer(mapping.outputHeight, artifact, 'dewarpMapping.outputHeight', 1);
        for (const key of [
            'outputToSource',
            'sourceToOutput',
        ] as const) {
            if (!Array.isArray(mapping[key]) || mapping[key].length !== pointCount) fail(artifact, `dewarpMapping.${key} length does not match its grid`);
            mapping[key].forEach((point, index) => pixelPoint(point, artifact, `dewarpMapping.${key}[${String(index)}]`));
        }
    }
    if (source.softMarginsPx !== undefined) {
        if (!Array.isArray(source.softMarginsPx) || source.softMarginsPx.length !== 4) fail(artifact, 'softMarginsPx must contain four values');
        source.softMarginsPx.forEach((item, index) => integer(item, artifact, `softMarginsPx[${String(index)}]`));
    }
}

export function decodeNativeScanCleanupOutputMetadata(
    value: unknown,
): INativeScanCleanupOutputMetadataV3 {
    const artifact = 'output metadata' as const;
    const decodedSource = record(value, artifact, 'root');
    // These fields were added to protocol-v3 output metadata together. Older
    // artifacts represent the same identity placement with their absence.
    // Normalize that legacy shape so downstream geometry never observes
    // undefined numbers or transforms.
    const source = decodedSource.placementOffsetXPx === undefined
        || decodedSource.placementOffsetYPx === undefined
        || decodedSource.forwardTransform === undefined
        || decodedSource.rotationDegrees === undefined
        ? {
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
            forwardTransform: null,
            rotationDegrees: 0,
            ...decodedSource,
        }
        : decodedSource;
    validateVersion(source, artifact);
    const outputWidthPx = integer(source.outputWidthPx, artifact, 'outputWidthPx', 1);
    const outputHeightPx = integer(source.outputHeightPx, artifact, 'outputHeightPx', 1);
    const canvasWidthPx = integer(source.canvasWidthPx, artifact, 'canvasWidthPx', 1);
    const canvasHeightPx = integer(source.canvasHeightPx, artifact, 'canvasHeightPx', 1);
    oneOf(source.layoutClassification, LAYOUTS, artifact, 'layoutClassification');
    if (typeof source.skewApplied !== 'boolean') fail(artifact, 'skewApplied must be boolean');
    const placementOffsetXPx = integer(source.placementOffsetXPx, artifact, 'placementOffsetXPx');
    const placementOffsetYPx = integer(source.placementOffsetYPx, artifact, 'placementOffsetYPx');
    affine(source.forwardTransform, artifact, 'forwardTransform');
    oneOf(source.rotationDegrees, ROTATIONS, artifact, 'rotationDegrees');
    validateOutputOptionals(source, artifact);
    if (source.warnings !== undefined) {
        if (!Array.isArray(source.warnings) || source.warnings.length > MAX_WARNINGS) fail(artifact, 'warnings exceeds the protocol limit');
        source.warnings.forEach((warning, index) => {
            if (typeof warning !== 'string' || warning.length > MAX_WARNING_LENGTH) fail(artifact, `warnings[${String(index)}] is invalid`);
        });
    }
    const contentWidth = source.matchedCanvasContentWidthPx ?? outputWidthPx;
    const contentHeight = source.matchedCanvasContentHeightPx ?? outputHeightPx;
    if (
        typeof contentWidth !== 'number'
        || typeof contentHeight !== 'number'
        || placementOffsetXPx + contentWidth > canvasWidthPx
        || placementOffsetYPx + contentHeight > canvasHeightPx
    ) fail(artifact, 'intrinsic content placement exceeds its canvas');
    return decoded<INativeScanCleanupOutputMetadataV3>(source);
}

export function decodeNativeScanCleanupOutputMetadataJson(text: string) {
    return decodeNativeScanCleanupOutputMetadata(parseJson(
        text,
        'output metadata',
        MAX_OUTPUT_METADATA_JSON_LENGTH,
    ));
}

export function decodeNativeScanCleanupPreviewOutputMetadataJson(
    text: string,
): TNativeScanCleanupPreviewOutputArtifactMetadataV3 {
    const metadata = decodeNativeScanCleanupOutputMetadataJson(text);
    const source = record(metadata, 'output metadata', 'root');
    for (const key of [
        'half',
        'layoutConfidence',
        'sourceRegion',
        'contentBox',
        'appliedMargins',
        'cutterXPx',
        'inputWidthPx',
        'inputHeightPx',
        'canvasScope',
        'resamplePasses',
        'warnings',
    ] as const) if (!(key in source)) fail('output metadata', `${key} is required for preview`);
    return metadata as TNativeScanCleanupPreviewOutputArtifactMetadataV3;
}
