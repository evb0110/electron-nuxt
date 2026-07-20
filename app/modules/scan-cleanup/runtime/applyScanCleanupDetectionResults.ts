import type {
    IScanCleanupDetectionResult,
    IScanCleanupPreviewMetadata,
} from '@contracts/electronApiScanCleanup';

export function applyScanCleanupDetectionResults(
    results: readonly IScanCleanupDetectionResult[],
    classifications: Map<number, IScanCleanupPreviewMetadata['layoutClassification']>,
    confidences: Map<number, number>,
    accepts: (pageNumber: number) => boolean = () => true,
) {
    for (const result of results) {
        if (!accepts(result.pageNumber)) {
            continue;
        }
        classifications.set(result.pageNumber, result.classification);
        confidences.set(result.pageNumber, result.confidence);
    }
}
