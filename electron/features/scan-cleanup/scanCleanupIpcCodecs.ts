import type { TIpcCodecMap } from '@contracts/ipcMain';
import { isRecord } from '@contracts/runtimeGuards';
import {NATIVE_ERROR_CODES} from '@contracts/nativeErrors';
import type {
    IScanCleanupProgress,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewResult,
    IScanCleanupSummary,
    TScanCleanupErrorCode,
    TScanCleanupDetectionJobState,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';
import {
    SCAN_CLEANUP_CHANNELS,
    type IScanCleanupInvokeMap,
} from '@electron/features/scan-cleanup/contract';
import {
    decodeDetectionArgs,
    decodeDocumentPrior,
    decodeFiniteNumber,
    decodeOpenPdfPaths,
    decodeOwnedJobId,
    decodePreviewArgs,
    decodePreviewCancelArgs,
    decodeStartArgs,
    isLayoutClassification,
} from '@electron/features/scan-cleanup/scanCleanupIpcRequestCodecs';

const PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PREVIEW_MAX_TOTAL_BYTES = 96 * 1024 * 1024;

function decodePreviewBytes(value: unknown, label: string) {
    if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return value;
}

function decodePositiveInteger(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return value;
}

function decodeNonNegativeFiniteNumber(value: unknown, label: string) {
    const decoded = decodeFiniteNumber(value, label);
    if (decoded < 0) throw new Error(`invalid scan-cleanup preview ${label}`);
    return decoded;
}

function decodePreviewRect(value: unknown, label: string) {
    if (!isRecord(value)) throw new Error(`invalid scan-cleanup preview ${label}`);
    const rect = {
        xPx: decodeFiniteNumber(value.xPx, `${label} x`),
        yPx: decodeFiniteNumber(value.yPx, `${label} y`),
        widthPx: decodeFiniteNumber(value.widthPx, `${label} width`),
        heightPx: decodeFiniteNumber(value.heightPx, `${label} height`),
    };
    if (rect.widthPx < 0 || rect.heightPx < 0) throw new Error(`invalid scan-cleanup preview ${label}`);
    return rect;
}

function decodePreviewAffine(value: unknown) {
    if (value === null) {
        return null;
    }
    if (
        !isRecord(value)
        || !Array.isArray(value.matrix)
        || value.matrix.length !== 3
        || value.matrix.some(row => !Array.isArray(row)
            || row.length !== 3
            || row.some(item => typeof item !== 'number' || !Number.isFinite(item)))
    ) throw new Error('invalid scan-cleanup preview affine');
    const rows = value.matrix as unknown[];
    return {matrix: rows.map((row, rowIndex) => (row as unknown[]).map((item, columnIndex) => (
        decodeFiniteNumber(item, `affine ${rowIndex}:${columnIndex}`)
    )))};
}

function decodeContentDiagnostics(
    value: unknown,
): NonNullable<IScanCleanupPreviewMetadata['contentDiagnostics']> {
    if (!isRecord(value) || !isRecord(value.sideConfidence) || !isRecord(value.textMask)) {
        throw new Error('invalid scan-cleanup preview content diagnostics');
    }
    const textMask = value.textMask;
    return {
        sideConfidence: decodeContentSideConfidence(value.sideConfidence),
        textMask: {
            analysisWidthPx: decodePositiveInteger(textMask.analysisWidthPx, 'text-mask analysis width'),
            analysisHeightPx: decodePositiveInteger(textMask.analysisHeightPx, 'text-mask analysis height'),
            inkPixels: decodeNonNegativeInteger(textMask.inkPixels, 'text-mask ink pixels'),
            lineCount: decodeNonNegativeInteger(textMask.lineCount, 'text-mask line count'),
            ...(textMask.bounds === undefined
                ? {}
                : {bounds: decodePreviewRect(textMask.bounds, 'text-mask bounds')}),
        },
    };
}

function decodeContentSideConfidence(value: unknown) {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup preview content side confidence');
    return {
        left: decodeUnitInterval(value.left, 'content left confidence'),
        top: decodeUnitInterval(value.top, 'content top confidence'),
        right: decodeUnitInterval(value.right, 'content right confidence'),
        bottom: decodeUnitInterval(value.bottom, 'content bottom confidence'),
    };
}

function decodeBinarizationDiagnostics(
    value: unknown,
): NonNullable<IScanCleanupPreviewMetadata['binarizationDiagnostics']> {
    if (
        !isRecord(value)
        || ![
            'auto',
            'otsu',
            'sauvola',
            'wolf',
        ].includes(String(value.route))
    ) throw new Error('invalid scan-cleanup preview binarization diagnostics');
    return {
        route: value.route as NonNullable<IScanCleanupPreviewMetadata['binarizationMode']>,
        robustContrast: decodeFiniteNumber(value.robustContrast, 'binarization robust contrast'),
        illuminationDeviation: decodeFiniteNumber(value.illuminationDeviation, 'binarization illumination deviation'),
        edgeDensity: decodeFiniteNumber(value.edgeDensity, 'binarization edge density'),
        estimatedStrokeWidthPx: decodeFiniteNumber(value.estimatedStrokeWidthPx, 'binarization stroke width'),
        darkBorderCoverage: decodeFiniteNumber(value.darkBorderCoverage, 'binarization border coverage'),
        otsuAdaptiveAgreement: decodeFiniteNumber(value.otsuAdaptiveAgreement, 'binarization agreement'),
    };
}

function decodeSplitSeam(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.points) || value.points.length < 2) {
        throw new Error('invalid scan-cleanup preview split seam');
    }
    return {points: value.points.map((point, index) => {
        if (!isRecord(point)) throw new Error(`invalid scan-cleanup preview split seam point ${index}`);
        return {
            x: decodeFiniteNumber(point.x, `split seam point ${index} x`),
            y: decodeFiniteNumber(point.y, `split seam point ${index} y`),
        };
    })};
}

function decodePreviewMetadata(value: unknown): IScanCleanupPreviewMetadata {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup preview metadata');
    if (
        ![
            'full',
            'left',
            'right',
        ].includes(String(value.half))
        || ![
            'single-uncut-page',
            'page-with-offcut',
            'two-page-spread',
        ].includes(String(value.layoutClassification))
        || !isRecord(value.appliedMargins)
        || !Array.isArray(value.warnings)
        || value.warnings.some(item => typeof item !== 'string')
        || ![
            0,
            90,
            180,
            270,
        ].includes(Number(value.rotationDegrees))
        || (value.canvasPolicy !== undefined && ![
            'intrinsic',
            'robust-quantile',
            'overflow-intrinsic',
        ].includes(String(value.canvasPolicy)))
        || (value.canvasOverflow !== undefined && typeof value.canvasOverflow !== 'boolean')
        || (value.illuminationNormalized !== undefined && typeof value.illuminationNormalized !== 'boolean')
        || (value.despeckleFallback !== undefined && typeof value.despeckleFallback !== 'boolean')
        || (value.skewApplied !== undefined && typeof value.skewApplied !== 'boolean')
        || (value.manualSkew !== undefined && typeof value.manualSkew !== 'boolean')
        || (value.splitAbstained !== undefined && typeof value.splitAbstained !== 'boolean')
        || (value.dewarpApplied !== undefined && typeof value.dewarpApplied !== 'boolean')
        || (value.binarizationMode !== undefined
            && value.binarizationMode !== null
            && ![
                'auto',
                'otsu',
                'sauvola',
                'wolf',
            ].includes(String(value.binarizationMode)))
    ) throw new Error('invalid scan-cleanup preview metadata');
    const metadata: IScanCleanupPreviewMetadata = {
        half: value.half as IScanCleanupPreviewMetadata['half'],
        layoutClassification: value.layoutClassification as IScanCleanupPreviewMetadata['layoutClassification'],
        layoutConfidence: value.layoutConfidence === undefined
            ? 0
            : decodeUnitInterval(value.layoutConfidence, 'layout confidence'),
        ...(value.detectedSkewDegrees === undefined
            ? {}
            : {detectedSkewDegrees: decodeFiniteNumber(value.detectedSkewDegrees, 'detected skew')}),
        ...(value.skewConfidence === undefined
            ? {}
            : {skewConfidence: decodeUnitInterval(value.skewConfidence, 'skew confidence')}),
        ...(value.skewApplied === undefined ? {} : {skewApplied: value.skewApplied}),
        ...(value.manualSkew === undefined ? {} : {manualSkew: value.manualSkew}),
        sourceRegion: decodePreviewRect(value.sourceRegion, 'source region'),
        contentBox: value.contentBox === null ? null : decodePreviewRect(value.contentBox, 'content box'),
        cropRect: value.cropRect === undefined
            ? {
                xPx: 0,
                yPx: 0,
                widthPx: decodePositiveInteger(value.outputWidthPx, 'output width'),
                heightPx: decodePositiveInteger(value.outputHeightPx, 'output height'),
            }
            : decodePreviewRect(value.cropRect, 'crop rect'),
        ...(value.contentDiagnostics === undefined
            ? {}
            : {contentDiagnostics: decodeContentDiagnostics(value.contentDiagnostics)}),
        appliedMargins: {
            leftPx: decodeNonNegativeFiniteNumber(value.appliedMargins.leftPx, 'applied left margin'),
            topPx: decodeNonNegativeFiniteNumber(value.appliedMargins.topPx, 'applied top margin'),
            rightPx: decodeNonNegativeFiniteNumber(value.appliedMargins.rightPx, 'applied right margin'),
            bottomPx: decodeNonNegativeFiniteNumber(value.appliedMargins.bottomPx, 'applied bottom margin'),
        },
        outputWidthPx: decodePositiveInteger(value.outputWidthPx, 'output width'),
        outputHeightPx: decodePositiveInteger(value.outputHeightPx, 'output height'),
        canvasWidthPx: decodePositiveInteger(value.canvasWidthPx, 'canvas width'),
        canvasHeightPx: decodePositiveInteger(value.canvasHeightPx, 'canvas height'),
        canvasPolicy: (value.canvasPolicy ?? 'intrinsic') as NonNullable<
            IScanCleanupPreviewMetadata['canvasPolicy']
        >,
        canvasOverflow: value.canvasOverflow === true,
        matchedCanvasTargetWidthPx: value.matchedCanvasTargetWidthPx === null
            || value.matchedCanvasTargetWidthPx === undefined
            ? null
            : decodePositiveInteger(value.matchedCanvasTargetWidthPx, 'matched canvas target width'),
        matchedCanvasTargetHeightPx: value.matchedCanvasTargetHeightPx === null
            || value.matchedCanvasTargetHeightPx === undefined
            ? null
            : decodePositiveInteger(value.matchedCanvasTargetHeightPx, 'matched canvas target height'),
        placementOffsetXPx: decodeNonNegativeInteger(value.placementOffsetXPx, 'placement offset x'),
        placementOffsetYPx: decodeNonNegativeInteger(value.placementOffsetYPx, 'placement offset y'),
        forwardTransform: decodePreviewAffine(value.forwardTransform),
        cutterXPx: value.cutterXPx === null ? null : decodeFiniteNumber(value.cutterXPx, 'cutter x'),
        ...(value.splitSeam === undefined ? {} : {splitSeam: decodeSplitSeam(value.splitSeam)}),
        ...(value.splitAbstained === undefined ? {} : {splitAbstained: value.splitAbstained}),
        inputWidthPx: decodePositiveInteger(value.inputWidthPx, 'input width'),
        inputHeightPx: decodePositiveInteger(value.inputHeightPx, 'input height'),
        rotationDegrees: value.rotationDegrees as IScanCleanupPreviewMetadata['rotationDegrees'],
        canvasScope: value.canvasScope === 'document' ? 'document' : value.canvasScope === 'page'
            ? 'page'
            : (() => { throw new Error('invalid scan-cleanup preview canvas scope'); })(),
        resamplePasses: decodeNonNegativeInteger(value.resamplePasses, 'resample passes'),
        ...(value.illuminationNormalized === undefined
            ? {}
            : {illuminationNormalized: value.illuminationNormalized}),
        ...(value.binarizationMode === undefined
            ? {}
            : {binarizationMode: value.binarizationMode as NonNullable<
                IScanCleanupPreviewMetadata['binarizationMode']
            > | null}),
        ...(value.binarizationDiagnostics === undefined
            ? {}
            : {binarizationDiagnostics: value.binarizationDiagnostics === null
                ? null
                : decodeBinarizationDiagnostics(value.binarizationDiagnostics)}),
        ...(value.despeckleFallback === undefined
            ? {}
            : {despeckleFallback: value.despeckleFallback}),
        ...(value.dewarpConfidence === undefined
            ? {}
            : {dewarpConfidence: value.dewarpConfidence === null
                ? null
                : decodeUnitInterval(value.dewarpConfidence, 'dewarp confidence')}),
        ...(value.dewarpApplied === undefined ? {} : {dewarpApplied: value.dewarpApplied}),
        warnings: value.warnings as string[],
    };
    if (
        metadata.canvasWidthPx < metadata.outputWidthPx
        || metadata.canvasHeightPx < metadata.outputHeightPx
        || metadata.placementOffsetXPx + metadata.outputWidthPx > metadata.canvasWidthPx
        || metadata.placementOffsetYPx + metadata.outputHeightPx > metadata.canvasHeightPx
    ) {
        throw new Error('invalid scan-cleanup preview intrinsic/canvas placement');
    }
    return metadata;
}

function decodeUnitInterval(value: unknown, label: string) {
    const decoded = decodeFiniteNumber(value, label);
    if (decoded < 0 || decoded > 1) throw new Error(`invalid scan-cleanup preview ${label}`);
    return decoded;
}

export function decodeScanCleanupPreviewResult(value: unknown): IScanCleanupPreviewResult {
    if (
        !isRecord(value)
        || !Array.isArray(value.outputs)
        || value.outputs.length > 2
    ) throw new Error('invalid scan-cleanup preview result');
    const rawImageData = decodePreviewBytes(value.rawImageData, 'raw image');
    let totalBytes = rawImageData.byteLength;
    const outputs = value.outputs.map(output => {
        if (!isRecord(output) || !isRecord(output.metadata)) throw new Error('invalid scan-cleanup preview output');
        const imageData = decodePreviewBytes(output.imageData, 'output image');
        totalBytes += imageData.byteLength;
        return {
            imageData,
            metadata: decodePreviewMetadata(output.metadata),
        };
    });
    if (totalBytes > PREVIEW_MAX_TOTAL_BYTES) throw new Error('invalid scan-cleanup preview total image bytes');
    const pageNumber = decodePositiveInteger(value.pageNumber, 'page number');
    const totalPages = decodePositiveInteger(value.totalPages, 'total pages');
    if (pageNumber > totalPages) throw new Error('invalid scan-cleanup preview page number');
    return {
        pageNumber,
        totalPages,
        rawImageData,
        rawWidthPx: decodePositiveInteger(value.rawWidthPx, 'raw width'),
        rawHeightPx: decodePositiveInteger(value.rawHeightPx, 'raw height'),
        pageMetadata: decodePreviewPageMetadata(value.pageMetadata),
        outputs,
    };
}

function decodePreviewPageMetadata(value: unknown): IScanCleanupPreviewResult['pageMetadata'] {
    if (
        !isRecord(value)
        || ![
            'single-uncut-page',
            'page-with-offcut',
            'two-page-spread',
        ].includes(String(value.layoutClassification))
        || !(value.cutterXPx === null || typeof value.cutterXPx === 'number' && Number.isFinite(value.cutterXPx))
        || ![
            0,
            90,
            180,
            270,
        ].includes(Number(value.rotationDegrees))
        || typeof value.excluded !== 'boolean'
        || (value.layoutConfidence !== undefined && (
            typeof value.layoutConfidence !== 'number'
            || !Number.isFinite(value.layoutConfidence)
            || value.layoutConfidence < 0
            || value.layoutConfidence > 1
        ))
        || (value.tier1Verdict !== undefined && !isLayoutClassification(value.tier1Verdict))
        || (value.reconciled !== undefined && typeof value.reconciled !== 'boolean')
        || (value.clusterAgreement !== undefined && (
            typeof value.clusterAgreement !== 'number'
            || !Number.isFinite(value.clusterAgreement)
            || value.clusterAgreement < -1
            || value.clusterAgreement > 1
        ))
        || (value.splitAbstained !== undefined && typeof value.splitAbstained !== 'boolean')
        || (value.despeckleFallback !== undefined && typeof value.despeckleFallback !== 'boolean')
        || (value.autoDewarpAttempted !== undefined && typeof value.autoDewarpAttempted !== 'boolean')
        || (value.manualSkew !== undefined && typeof value.manualSkew !== 'boolean')
        || (value.dewarpApplied !== undefined && typeof value.dewarpApplied !== 'boolean')
        || (value.binarizationMode !== undefined
            && value.binarizationMode !== null
            && ![
                'auto',
                'otsu',
                'sauvola',
                'wolf',
            ].includes(String(value.binarizationMode)))
    ) throw new Error('invalid scan-cleanup preview page metadata');
    return {
        layoutClassification: value.layoutClassification as IScanCleanupPreviewResult['pageMetadata']['layoutClassification'],
        ...(value.layoutConfidence === undefined
            ? {}
            : {layoutConfidence: decodeUnitInterval(value.layoutConfidence, 'page layout confidence')}),
        cutterXPx: value.cutterXPx,
        ...(value.splitSeam === undefined ? {} : {splitSeam: decodeSplitSeam(value.splitSeam)}),
        ...(value.splitAbstained === undefined ? {} : {splitAbstained: value.splitAbstained}),
        rotationDegrees: value.rotationDegrees as IScanCleanupPreviewResult['pageMetadata']['rotationDegrees'],
        canvasScope: value.canvasScope === 'document' ? 'document' : value.canvasScope === 'page'
            ? 'page'
            : (() => { throw new Error('invalid scan-cleanup preview canvas scope'); })(),
        excluded: value.excluded,
        blankOutputsSkipped: decodeNonNegativeInteger(value.blankOutputsSkipped, 'blank outputs skipped'),
        tier1Verdict: isLayoutClassification(value.tier1Verdict)
            ? value.tier1Verdict
            : value.layoutClassification as IScanCleanupPreviewResult['pageMetadata']['tier1Verdict'],
        reconciled: value.reconciled === true,
        clusterAgreement: value.clusterAgreement === undefined
            ? 0
            : (() => {
                const agreement = decodeFiniteNumber(value.clusterAgreement, 'cluster agreement');
                if (agreement < -1 || agreement > 1) throw new Error('invalid scan-cleanup cluster agreement');
                return agreement;
            })(),
        ...(value.detectedSkewDegrees === undefined
            ? {}
            : {detectedSkewDegrees: decodeFiniteNumber(value.detectedSkewDegrees, 'page detected skew')}),
        ...(value.skewConfidence === undefined
            ? {}
            : {skewConfidence: decodeUnitInterval(value.skewConfidence, 'page skew confidence')}),
        ...(value.manualSkew === undefined ? {} : {manualSkew: value.manualSkew}),
        ...(value.binarizationMode === undefined
            ? {}
            : {binarizationMode: value.binarizationMode as NonNullable<
                IScanCleanupPreviewResult['pageMetadata']['binarizationMode']
            > | null}),
        ...(value.binarizationDiagnostics === undefined
            ? {}
            : {binarizationDiagnostics: value.binarizationDiagnostics === null
                ? null
                : decodeBinarizationDiagnostics(value.binarizationDiagnostics)}),
        ...(value.despeckleFallback === undefined
            ? {}
            : {despeckleFallback: value.despeckleFallback}),
        ...(value.autoDewarpAttempted === undefined
            ? {}
            : {autoDewarpAttempted: value.autoDewarpAttempted}),
        ...(value.dewarpApplied === undefined
            ? {}
            : {dewarpApplied: value.dewarpApplied}),
        ...(value.dewarpConfidence === undefined
            ? {}
            : {dewarpConfidence: value.dewarpConfidence === null
                ? null
                : decodeUnitInterval(value.dewarpConfidence, 'page dewarp confidence')}),
        ...(value.contentSideConfidence === undefined
            ? {}
            : {contentSideConfidence: decodeContentSideConfidence(value.contentSideConfidence)}),
    };
}

function decodeStartResult(value: unknown) {
    if (!isRecord(value) || typeof value.started !== 'boolean' || typeof value.jobId !== 'string') throw new Error('invalid scan-cleanup start result');
    if (value.started) {
        if (typeof value.outputPdfPath !== 'string') throw new Error('successful scan-cleanup start requires outputPdfPath');
        return {
            started: true as const,
            jobId: value.jobId,
            outputPdfPath: value.outputPdfPath,
        };
    }
    if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
        throw new Error('failed scan-cleanup start requires a typed error');
    }
    return {
        started: false as const,
        jobId: value.jobId,
        error: value.error,
        errorCode: value.errorCode,
    };
}

function decodeDetectionStartResult(value: unknown) {
    if (!isRecord(value) || typeof value.started !== 'boolean' || typeof value.jobId !== 'string') {
        throw new Error('invalid scan-cleanup detection start result');
    }
    if (value.started) {
        return {
            started: true as const,
            jobId: value.jobId,
        };
    }
    if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
        throw new Error('failed scan-cleanup detection start requires a typed error');
    }
    return {
        started: false as const,
        jobId: value.jobId,
        error: value.error,
        errorCode: value.errorCode,
    };
}

function isScanCleanupStage(value: unknown): value is IScanCleanupProgress['stage'] {
    return value === 'queued'
        || value === 'normalizing'
        || value === 'rasterizing'
        || value === 'cleaning'
        || value === 'assembling'
        || value === 'handoff'
        || value === 'detecting';
}

function isScanCleanupErrorCode(value: unknown): value is TScanCleanupErrorCode {
    return NATIVE_ERROR_CODES.includes(value as typeof NATIVE_ERROR_CODES[number])
        || value === 'tools-unavailable'
        || value === 'canceled'
        || value === 'internal';
}

function decodeProgress(value: unknown): IScanCleanupProgress {
    if (
        !isRecord(value)
        || !isScanCleanupStage(value.stage)
        || typeof value.completedUnits !== 'number'
        || !Number.isSafeInteger(value.completedUnits)
        || value.completedUnits < 0
        || typeof value.totalUnits !== 'number'
        || !Number.isSafeInteger(value.totalUnits)
        || value.totalUnits < 0
        || value.completedUnits > value.totalUnits
        || typeof value.percent !== 'number'
        || !Number.isFinite(value.percent)
        || value.percent < 0
        || value.percent > 100
    ) throw new Error('invalid scan-cleanup progress');
    const completedPageNumbers = value.completedPageNumbers;
    const totalUnits = value.totalUnits;
    if (
        completedPageNumbers !== undefined
        && (!Array.isArray(completedPageNumbers)
            || completedPageNumbers.length !== value.completedUnits
            || new Set(completedPageNumbers).size !== completedPageNumbers.length
            || completedPageNumbers.some(page => !Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > totalUnits))
    ) throw new Error('invalid scan-cleanup completed page numbers');
    return {
        stage: value.stage,
        completedUnits: value.completedUnits,
        totalUnits: value.totalUnits,
        percent: value.percent,
        ...(completedPageNumbers === undefined ? {} : {completedPageNumbers: completedPageNumbers.map(Number)}),
    };
}

function decodeNonNegativeInteger(value: unknown, fieldName: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`invalid scan-cleanup ${fieldName}`);
    }
    return value;
}

function decodeSummary(value: unknown): IScanCleanupSummary {
    if (
        !isRecord(value)
        || !Array.isArray(value.warnings)
        || value.warnings.some(item => typeof item !== 'string')
    ) throw new Error('invalid scan-cleanup summary');
    return {
        inputPages: decodeNonNegativeInteger(value.inputPages, 'inputPages'),
        outputPages: decodeNonNegativeInteger(value.outputPages, 'outputPages'),
        spreadsSplit: decodeNonNegativeInteger(value.spreadsSplit, 'spreadsSplit'),
        offcutsDiscarded: decodeNonNegativeInteger(value.offcutsDiscarded, 'offcutsDiscarded'),
        deskewSkipped: decodeNonNegativeInteger(value.deskewSkipped, 'deskewSkipped'),
        cropSkipped: decodeNonNegativeInteger(value.cropSkipped, 'cropSkipped'),
        excludedPages: decodeNonNegativeInteger(value.excludedPages, 'excludedPages'),
        blankPagesSkipped: decodeNonNegativeInteger(value.blankPagesSkipped, 'blankPagesSkipped'),
        warnings: value.warnings.filter((item): item is string => typeof item === 'string'),
    };
}

export function decodeScanCleanupJobState(value: unknown): TScanCleanupJobState | null {
    if (value === null) {
        return null;
    }
    if (
        !isRecord(value)
        || typeof value.jobId !== 'string'
        || typeof value.updatedAtMs !== 'number'
        || !Number.isFinite(value.updatedAtMs)
    ) {
        throw new Error('invalid scan-cleanup job state');
    }
    const base = {
        jobId: value.jobId,
        progress: decodeProgress(value.progress),
        updatedAtMs: value.updatedAtMs,
    };
    if (value.status === 'queued' || value.status === 'running' || value.status === 'canceling' || value.status === 'handoff' || value.status === 'canceled') {
        return {
            ...base,
            status: value.status,
        };
    }
    if (value.status === 'completed') {
        if (typeof value.outputPdfPath !== 'string') throw new Error('completed scan-cleanup state requires outputPdfPath');
        return {
            ...base,
            status: 'completed',
            outputPdfPath: value.outputPdfPath,
            summary: decodeSummary(value.summary),
            runOcrAfterCleanup: value.runOcrAfterCleanup === true,
        };
    }
    if (value.status === 'failed') {
        if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
            throw new Error('failed scan-cleanup state requires a typed error');
        }
        return {
            ...base,
            status: 'failed',
            error: value.error,
            errorCode: value.errorCode,
        };
    }
    throw new Error('invalid scan-cleanup job status');
}

export function decodeScanCleanupDetectionJobState(value: unknown): TScanCleanupDetectionJobState | null {
    if (value === null) {
        return null;
    }
    if (
        !isRecord(value)
        || typeof value.jobId !== 'string'
        || typeof value.updatedAtMs !== 'number'
        || !Number.isFinite(value.updatedAtMs)
        || !isRecord(value.progress)
        || !Array.isArray(value.results)
    ) throw new Error('invalid scan-cleanup detection job state');
    const progress = decodeProgress(value.progress);
    const results = value.results.map(result => {
        if (
            !isRecord(result)
            || ![
                'single-uncut-page',
                'page-with-offcut',
                'two-page-spread',
            ].includes(String(result.classification))
            || !(result.cutterXPx === null || typeof result.cutterXPx === 'number' && Number.isFinite(result.cutterXPx))
            || (result.tier1Verdict !== undefined && !isLayoutClassification(result.tier1Verdict))
            || (result.reconciled !== undefined && typeof result.reconciled !== 'boolean')
            || (result.clusterAgreement !== undefined && (
                typeof result.clusterAgreement !== 'number'
                || !Number.isFinite(result.clusterAgreement)
                || result.clusterAgreement < -1
                || result.clusterAgreement > 1
            ))
            || (result.textAxis !== undefined && (
                !isRecord(result.textAxis)
                || Object.keys(result.textAxis).some(key => key !== 'sideways' && key !== 'confidence')
                || typeof result.textAxis.sideways !== 'boolean'
                || typeof result.textAxis.confidence !== 'number'
                || !Number.isFinite(result.textAxis.confidence)
                || result.textAxis.confidence < 0
                || result.textAxis.confidence > 1
            ))
        ) throw new Error('invalid scan-cleanup detection result');
        return {
            pageNumber: decodePositiveInteger(result.pageNumber, 'detection page number'),
            classification: result.classification as TScanCleanupDetectionJobState['results'][number]['classification'],
            confidence: decodeUnitInterval(result.confidence, 'detection confidence'),
            cutterXPx: result.cutterXPx,
            tier1Verdict: isLayoutClassification(result.tier1Verdict)
                ? result.tier1Verdict
                : result.classification as TScanCleanupDetectionJobState['results'][number]['tier1Verdict'],
            reconciled: result.reconciled === true,
            clusterAgreement: result.clusterAgreement === undefined
                ? 0
                : (() => {
                    const agreement = decodeFiniteNumber(result.clusterAgreement, 'detection cluster agreement');
                    if (agreement < -1 || agreement > 1) throw new Error('invalid scan-cleanup detection cluster agreement');
                    return agreement;
                })(),
            documentPrior: result.documentPrior === null || result.documentPrior === undefined
                ? null
                : decodeDocumentPrior(result.documentPrior),
            ...(isRecord(result.textAxis) ? {textAxis: {
                sideways: result.textAxis.sideways as boolean,
                confidence: result.textAxis.confidence as number,
            }} : {}),
        };
    });
    if (results.length !== progress.completedUnits) throw new Error('invalid scan-cleanup detection result count');
    const base = {
        jobId: value.jobId,
        progress,
        results,
        updatedAtMs: value.updatedAtMs,
    };
    if (value.status === 'queued' || value.status === 'running' || value.status === 'canceling' || value.status === 'completed' || value.status === 'canceled') {
        return {
            ...base,
            status: value.status,
        };
    }
    if (value.status === 'failed') {
        if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
            throw new Error('failed scan-cleanup detection state requires a typed error');
        }
        return {
            ...base,
            status: 'failed',
            error: value.error,
            errorCode: value.errorCode,
        };
    }
    throw new Error('invalid scan-cleanup detection job status');
}

export const SCAN_CLEANUP_IPC_CODECS = {
    [SCAN_CLEANUP_CHANNELS.preview]: {
        encodeArgs: decodePreviewArgs,
        decodeArgs: decodePreviewArgs,
        decodeResult: decodeScanCleanupPreviewResult,
    },
    [SCAN_CLEANUP_CHANNELS.cancelPreview]: {
        encodeArgs: decodePreviewCancelArgs,
        decodeArgs: decodePreviewCancelArgs,
        decodeResult: (value: unknown) => {
            if (typeof value !== 'boolean') throw new Error('invalid scan-cleanup preview cancel result');
            return value;
        },
    },
    [SCAN_CLEANUP_CHANNELS.detectAll]: {
        encodeArgs: decodeDetectionArgs,
        decodeArgs: decodeDetectionArgs,
        decodeResult: decodeDetectionStartResult,
    },
    [SCAN_CLEANUP_CHANNELS.cancelDetection]: {
        encodeArgs: decodeOwnedJobId,
        decodeArgs: decodeOwnedJobId,
        decodeResult: (value: unknown) => {
            if (typeof value !== 'boolean') throw new Error('invalid scan-cleanup detection cancel result');
            return value;
        },
    },
    [SCAN_CLEANUP_CHANNELS.getDetectionJobState]: {
        encodeArgs: decodeOwnedJobId,
        decodeArgs: decodeOwnedJobId,
        decodeResult: decodeScanCleanupDetectionJobState,
    },
    [SCAN_CLEANUP_CHANNELS.subscribeDetectionJob]: {
        encodeArgs: decodeOwnedJobId,
        decodeArgs: decodeOwnedJobId,
        decodeResult: decodeScanCleanupDetectionJobState,
    },
    [SCAN_CLEANUP_CHANNELS.start]: {
        encodeArgs: decodeStartArgs,
        decodeArgs: decodeStartArgs,
        decodeResult: decodeStartResult,
    },
    [SCAN_CLEANUP_CHANNELS.cancel]: {
        encodeArgs: decodeOwnedJobId,
        decodeArgs: decodeOwnedJobId,
        decodeResult: (value: unknown) => {
            if (typeof value !== 'boolean') throw new Error('invalid scan-cleanup cancel result');
            return value;
        },
    },
    [SCAN_CLEANUP_CHANNELS.getJobState]: {
        encodeArgs: decodeOwnedJobId,
        decodeArgs: decodeOwnedJobId,
        decodeResult: decodeScanCleanupJobState,
    },
    [SCAN_CLEANUP_CHANNELS.subscribeJob]: {
        encodeArgs: decodeOwnedJobId,
        decodeArgs: decodeOwnedJobId,
        decodeResult: decodeScanCleanupJobState,
    },
    [SCAN_CLEANUP_CHANNELS.reconnectJob]: {
        encodeArgs: decodeOwnedJobId,
        decodeArgs: decodeOwnedJobId,
        decodeResult: decodeScanCleanupJobState,
    },
    [SCAN_CLEANUP_CHANNELS.pruneGeneratedOutputs]: {
        encodeArgs: decodeOpenPdfPaths,
        decodeArgs: decodeOpenPdfPaths,
        decodeResult: (value: unknown) => {
            if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('invalid scan-cleanup prune result');
            return Number(value);
        },
    },
} satisfies TIpcCodecMap<IScanCleanupInvokeMap>;
