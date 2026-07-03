import type { TPdfSaveMode } from '@app/types/pdfContracts';
import type { IPdfPersistResult } from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';

export function createPdfPersistResult(
    success: boolean,
    saveMode: TPdfSaveMode,
    didSaveAs: boolean,
    outPath: TDocumentRef | null,
): IPdfPersistResult {
    return {
        success,
        outPath,
        saveMode,
        didSaveAs,
    };
}
