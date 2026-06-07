import type { TDocumentRef } from '@contracts/documentRef';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

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
