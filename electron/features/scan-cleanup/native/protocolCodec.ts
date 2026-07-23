import {
    isNativeErrorEnvelope,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {isRecord} from '@contracts/runtimeGuards';
import type {
    IScanCleanupDocumentPrior,
    IScanCleanupTextAxis,
    INativeScanCleanupProgressEnvelopeV3,
    INativeScanCleanupProgressV3,
    INativeScanCleanupResultEnvelopeV3,
    TNativeScanCleanupEnvelopeV3,
} from '@contracts/electronApiScanCleanup';
import {SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION} from '@contracts/electronApiScanCleanup';
import {isScanCleanupOutputModeRecommendationReason} from '@electron/features/scan-cleanup/isScanCleanupOutputMode';

function isNonNegativeInteger(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isProgressStage(value: unknown): value is INativeScanCleanupProgressV3['stage'] {
    return value === 'started'
        || value === 'page-analyzed'
        || value === 'page-complete'
        || value === 'completed';
}

function isClassification(value: unknown): value is NonNullable<INativeScanCleanupProgressV3['classification']> {
    return value === 'single-uncut-page'
        || value === 'page-with-offcut'
        || value === 'two-page-spread';
}

function isOutputMode(value: unknown): value is NonNullable<INativeScanCleanupProgressV3['recommendedOutputMode']> {
    return value === 'bw' || value === 'mixed' || value === 'grayscale' || value === 'color';
}

function decodeDocumentPrior(value: unknown): IScanCleanupDocumentPrior {
    if (
        !isRecord(value)
        || !isClassification(value.dominantLayout)
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
    ) throw new Error('Invalid evb-scan-cleanup document prior');
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

function decodeTextAxis(value: unknown): IScanCleanupTextAxis {
    if (
        !isRecord(value)
        || Object.keys(value).some(key => key !== 'sideways' && key !== 'confidence')
        || typeof value.sideways !== 'boolean'
        || typeof value.confidence !== 'number'
        || !Number.isFinite(value.confidence)
        || value.confidence < 0
        || value.confidence > 1
    ) throw new Error('Invalid evb-scan-cleanup text axis');
    return {
        sideways: value.sideways,
        confidence: value.confidence,
    };
}

function decodeProgress(value: unknown): INativeScanCleanupProgressV3 {
    if (
        !isRecord(value)
        || !isProgressStage(value.stage)
        || !isNonNegativeInteger(value.completedPages)
        || !isNonNegativeInteger(value.totalPages)
        || Number(value.completedPages) > Number(value.totalPages)
    ) throw new Error('Invalid evb-scan-cleanup progress envelope');
    if (
        ((value.stage === 'page-analyzed' || value.stage === 'page-complete') && value.pageNumber === undefined)
        || (value.pageNumber !== undefined && (
            !Number.isSafeInteger(value.pageNumber)
            || Number(value.pageNumber) < 1
            || Number(value.pageNumber) > Number(value.totalPages)
        ))
    ) {
        throw new Error('Invalid evb-scan-cleanup progress page number');
    }
    if (value.outputPaths !== undefined && (!Array.isArray(value.outputPaths) || value.outputPaths.some(path => typeof path !== 'string'))) {
        throw new Error('Invalid evb-scan-cleanup progress output paths');
    }
    if (value.classification !== undefined && !isClassification(value.classification)) {
        throw new Error('Invalid evb-scan-cleanup progress classification');
    }
    if (value.confidence !== undefined && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence))) {
        throw new Error('Invalid evb-scan-cleanup progress confidence');
    }
    if (value.cutterXPx !== undefined && (typeof value.cutterXPx !== 'number' || !Number.isFinite(value.cutterXPx))) {
        throw new Error('Invalid evb-scan-cleanup progress cutter');
    }
    if (value.tier1Verdict !== undefined && !isClassification(value.tier1Verdict)) {
        throw new Error('Invalid evb-scan-cleanup Tier-1 verdict');
    }
    if (value.reconciled !== undefined && typeof value.reconciled !== 'boolean') {
        throw new Error('Invalid evb-scan-cleanup reconciliation flag');
    }
    if (value.clusterAgreement !== undefined && (
        typeof value.clusterAgreement !== 'number'
        || !Number.isFinite(value.clusterAgreement)
        || value.clusterAgreement < -1
        || value.clusterAgreement > 1
    )) throw new Error('Invalid evb-scan-cleanup cluster agreement');
    if (value.recommendedOutputMode !== undefined && !isOutputMode(value.recommendedOutputMode)) {
        throw new Error('Invalid evb-scan-cleanup recommended output mode');
    }
    if (value.recommendedOutputModeConfidence !== undefined && (
        typeof value.recommendedOutputModeConfidence !== 'number'
        || !Number.isFinite(value.recommendedOutputModeConfidence)
        || value.recommendedOutputModeConfidence < 0
        || value.recommendedOutputModeConfidence > 1
    )) throw new Error('Invalid evb-scan-cleanup output mode confidence');
    if (
        value.recommendedOutputModeReason !== undefined
        && !isScanCleanupOutputModeRecommendationReason(value.recommendedOutputModeReason)
    ) throw new Error('Invalid evb-scan-cleanup output mode recommendation reason');
    if (
        value.stage === 'page-analyzed'
        && [
            value.classification,
            value.confidence,
            value.cutterXPx,
            value.tier1Verdict,
            value.reconciled,
            value.clusterAgreement,
            value.documentPrior,
            value.textAxis,
            value.recommendedOutputMode,
            value.recommendedOutputModeConfidence,
            value.recommendedOutputModeReason,
        ].some(item => item !== undefined)
    ) throw new Error('Invalid evb-scan-cleanup pre-reconciliation analysis progress');
    const documentPrior = value.documentPrior === undefined ? undefined : decodeDocumentPrior(value.documentPrior);
    const textAxis = value.textAxis === undefined ? undefined : decodeTextAxis(value.textAxis);
    return {
        stage: value.stage,
        completedPages: Number(value.completedPages),
        totalPages: Number(value.totalPages),
        ...(typeof value.pageNumber === 'number' ? {pageNumber: value.pageNumber} : {}),
        ...(Array.isArray(value.outputPaths) ? {outputPaths: value.outputPaths as string[]} : {}),
        ...(isClassification(value.classification) ? {classification: value.classification} : {}),
        ...(typeof value.confidence === 'number' ? {confidence: value.confidence} : {}),
        ...(typeof value.cutterXPx === 'number' ? {cutterXPx: value.cutterXPx} : {}),
        ...(isClassification(value.tier1Verdict) ? {tier1Verdict: value.tier1Verdict} : {}),
        ...(typeof value.reconciled === 'boolean' ? {reconciled: value.reconciled} : {}),
        ...(typeof value.clusterAgreement === 'number' ? {clusterAgreement: value.clusterAgreement} : {}),
        ...(documentPrior === undefined ? {} : {documentPrior}),
        ...(textAxis === undefined ? {} : {textAxis}),
        ...(isOutputMode(value.recommendedOutputMode)
            ? {recommendedOutputMode: value.recommendedOutputMode}
            : {}),
        ...(typeof value.recommendedOutputModeConfidence === 'number'
            ? {recommendedOutputModeConfidence: value.recommendedOutputModeConfidence}
            : {}),
        ...(isScanCleanupOutputModeRecommendationReason(value.recommendedOutputModeReason)
            ? {recommendedOutputModeReason: value.recommendedOutputModeReason}
            : {}),
    };
}

function decodeResult(value: unknown): INativeScanCleanupResultEnvelopeV3['result'] {
    if (!isRecord(value)) throw new Error('Invalid evb-scan-cleanup result envelope');
    if (value.status === 'success') {
        if (!isNonNegativeInteger(value.completedPages) || !isNonNegativeInteger(value.totalPages)) {
            throw new Error('Invalid evb-scan-cleanup success result');
        }
        return {
            status: 'success',
            completedPages: Number(value.completedPages),
            totalPages: Number(value.totalPages),
        };
    }
    if (value.status === 'failure' && isNativeErrorEnvelope(value)) {
        return {
            status: 'failure',
            code: value.code,
            message: value.message,
        };
    }
    throw new Error('Invalid evb-scan-cleanup failure result');
}

export function decodeNativeScanCleanupEnvelope(line: string): TNativeScanCleanupEnvelopeV3 {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || value.version !== SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION) {
        throw new Error('Unsupported evb-scan-cleanup NDJSON protocol version');
    }
    if (value.type === 'progress') {
        return {
            version: SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
            type: 'progress',
            progress: decodeProgress(value.progress),
        } satisfies INativeScanCleanupProgressEnvelopeV3;
    }
    if (value.type === 'result') {
        return {
            version: SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
            type: 'result',
            result: decodeResult(value.result),
        } satisfies INativeScanCleanupResultEnvelopeV3;
    }
    throw new Error('Unknown evb-scan-cleanup NDJSON envelope type');
}

export function parseNativeScanCleanupStderr(stderr: string): {
    code: TNativeErrorCode;
    message: string
} | null {
    for (const line of stderr.trim().split(/\r?\n/u).reverse()) {
        try {
            const value: unknown = JSON.parse(line);
            if (isNativeErrorEnvelope(value)) {
                return value;
            }
        } catch {
            // Deprecation notices and diagnostics may precede the final native envelope.
        }
    }
    return null;
}
