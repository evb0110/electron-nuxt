import type { TPdfSaveMode } from '@app/types/pdf';
import { createPdfPersistResult } from '@app/services/pdf-file/createPdfPersistResult';

export function createFailedPdfPersistResult(
    saveMode: TPdfSaveMode,
    didSaveAs: boolean,
) {
    return createPdfPersistResult(false, saveMode, didSaveAs, null);
}
