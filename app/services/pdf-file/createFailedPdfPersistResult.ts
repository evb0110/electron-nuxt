import type { TPdfSaveMode } from '@app/types/pdfContracts';
import { createPdfPersistResult } from '@app/services/pdf-file/createPdfPersistResult';

export function createFailedPdfPersistResult(
    saveMode: TPdfSaveMode,
    didSaveAs: boolean,
) {
    return createPdfPersistResult(false, saveMode, didSaveAs, null);
}
