import type {
    IScanCleanupDetectionResult,
    IScanCleanupDocumentPrior,
    IScanCleanupPreviewMetadata,
    IScanCleanupTextAxis,
} from '@contracts/electronApiScanCleanup';

export function applyScanCleanupDetectionResults(
    results: readonly IScanCleanupDetectionResult[],
    classifications: Map<number, IScanCleanupPreviewMetadata['layoutClassification']>,
    confidences: Map<number, number>,
    accepts: (pageNumber: number) => boolean = () => true,
    documentPriors?: Map<number, IScanCleanupDocumentPrior>,
    textAxes?: Map<number, IScanCleanupTextAxis>,
) {
    for (const result of results) {
        if (!accepts(result.pageNumber)) {
            continue;
        }
        classifications.set(result.pageNumber, result.classification);
        confidences.set(result.pageNumber, result.confidence);
        if (result.documentPrior === null) {
            documentPriors?.delete(result.pageNumber);
        } else {
            documentPriors?.set(result.pageNumber, result.documentPrior);
        }
        if (result.textAxis === undefined) {
            textAxes?.delete(result.pageNumber);
        } else {
            textAxes?.set(result.pageNumber, result.textAxis);
        }
    }
}
