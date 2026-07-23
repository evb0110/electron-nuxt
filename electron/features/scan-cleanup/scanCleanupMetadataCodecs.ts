import type {
    IScanCleanupDocumentPrior,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewResult,
} from '@contracts/electronApiScanCleanup';
import {isRecord} from '@contracts/runtimeGuards';

export function isScanCleanupLayoutClassification(
    value: unknown,
): value is IScanCleanupPreviewMetadata['layoutClassification'] {
    return value === 'single-uncut-page'
        || value === 'page-with-offcut'
        || value === 'two-page-spread';
}

export function isScanCleanupOutputMode(
    value: unknown,
): value is NonNullable<IScanCleanupPreviewResult['pageMetadata']['recommendedOutputMode']> {
    return value === 'bw' || value === 'mixed' || value === 'grayscale' || value === 'color';
}

export function decodeScanCleanupDocumentPrior(value: unknown): IScanCleanupDocumentPrior {
    if (
        !isRecord(value)
        || !isScanCleanupLayoutClassification(value.dominantLayout)
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
