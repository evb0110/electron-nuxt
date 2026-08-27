import type { TDocumentRef } from '@contracts/documentRef';
import type {IPdfConformanceAnalysisOptions} from '@contracts/pdfConformance';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentPdfCapability } from '@app/utils/platformDocuments';

export async function readPdfConformanceProfile(
    path: TDocumentRef,
    options?: IPdfConformanceAnalysisOptions,
) {
    try {
        const pdfCapability = getDocumentPdfCapability();
        return await (options === undefined
            ? pdfCapability.analyzePdfConformance(path)
            : pdfCapability.analyzePdfConformance(path, options));
    } catch (conformanceError) {
        BrowserLogger.warn('pdf-file', 'Failed to analyze PDF conformance profile', {
            path,
            error: conformanceError,
        });
        return null;
    }
}
