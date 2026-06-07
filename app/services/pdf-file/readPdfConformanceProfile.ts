import type { TDocumentRef } from '@contracts/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

export async function readPdfConformanceProfile(path: TDocumentRef) {
    try {
        return await getDocumentsCapability().analyzePdfConformance(path);
    } catch (conformanceError) {
        BrowserLogger.warn('pdf-file', 'Failed to analyze PDF conformance profile', {
            path,
            error: conformanceError,
        });
        return null;
    }
}
