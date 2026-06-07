import type {
    IPdfPersistResult,
    TPdfSaveMode,
} from '@app/types/pdf';
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
