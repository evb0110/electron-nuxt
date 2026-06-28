import type { TDocumentRef } from '@contracts/documentRef';
import {
    getDocumentFilesCapability,
    getDocumentPdfCapability,
} from '@app/utils/platformDocuments';

export async function savePdfBytesToWorkingCopy(
    workingPath: TDocumentRef,
    data: Uint8Array,
) {
    const documentFiles = getDocumentFilesCapability();
    if (typeof documentFiles.savePdfData === 'function') {
        return documentFiles.savePdfData(workingPath, data);
    }

    const validation = await getDocumentPdfCapability().validatePdfData(data);
    if (validation.isValid) {
        await documentFiles.writeFile(workingPath, data);
        await documentFiles.saveFile(workingPath);
    }
    return validation;
}
