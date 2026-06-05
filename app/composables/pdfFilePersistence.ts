import type {
    IPdfPersistResult,
    TPdfSaveMode,
} from '@app/types/pdf';
import type { TDocumentRef } from '@contracts/platformApi';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

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

export function createFailedPdfPersistResult(
    saveMode: TPdfSaveMode,
    didSaveAs: boolean,
) {
    return createPdfPersistResult(false, saveMode, didSaveAs, null);
}

export async function savePdfBytesToWorkingCopy(
    workingPath: TDocumentRef,
    data: Uint8Array,
) {
    const documents = getDocumentsCapability();
    if (typeof documents.savePdfData === 'function') {
        return documents.savePdfData(workingPath, data);
    }

    const validation = await documents.validatePdfData(data);
    if (validation.isValid) {
        await documents.writeFile(workingPath, data);
        await documents.saveFile(workingPath);
    }
    return validation;
}

export async function savePdfBytesAs(
    workingPath: TDocumentRef,
    data: Uint8Array,
) {
    const documents = getDocumentsCapability();
    if (typeof documents.savePdfDataAs === 'function') {
        return documents.savePdfDataAs(workingPath, data);
    }

    const validation = await documents.validatePdfData(data);
    if (!validation.isValid) {
        return {
            path: null,
            validation,
        };
    }

    await documents.writeFile(workingPath, data);
    return {
        path: await documents.savePdfAs(workingPath),
        validation,
    };
}
