import type { TDocumentRef } from '@contracts/documentRef';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

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
