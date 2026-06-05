import type {
    IPdfConformanceProfile,
    TPdfSaveMode,
} from '@app/types/pdf';
import type { TDocumentRef } from '@contracts/platformApi';
import { getDocumentsCapability } from '@app/utils/platformDocuments';
import { BrowserLogger } from '@app/utils/browserLogger';

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

export function shouldForcePdfSaveAs(
    mode: TPdfSaveMode,
    profile: IPdfConformanceProfile | null,
    requiresSaveAsOnFirstSave: boolean,
) {
    if (requiresSaveAsOnFirstSave) {
        return true;
    }
    if (!profile?.isSigned) {
        return false;
    }

    return mode === 'rewrite' || mode === 'save_as_rewrite';
}
