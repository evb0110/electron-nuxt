import type { TDocumentRef } from '@contracts/documentRef';
import type { IPdfSaveAsOptions } from '@contracts/electronApiDocuments';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

export async function savePdfBytesAs(
    workingPath: TDocumentRef,
    data: Uint8Array,
    options?: IPdfSaveAsOptions,
) {
    const documents = getDocumentsCapability();
    if (typeof documents.savePdfDataAs === 'function') {
        return options
            ? documents.savePdfDataAs(workingPath, data, options)
            : documents.savePdfDataAs(workingPath, data);
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
        path: options
            ? await documents.savePdfAs(workingPath, options)
            : await documents.savePdfAs(workingPath),
        validation,
    };
}
