import type { TDocumentRef } from '@contracts/documentRef';
import type { IPdfSaveAsOptions } from '@contracts/electronApiDocuments';
import { getDocumentsCapability } from '@app/utils/platformDocuments';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';

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

    const stagedWorkingPath = await documents.createWorkingCopyFromData(
        getDocumentRefBaseName(workingPath) ?? 'document.pdf',
        data,
    );
    try {
        return {
            path: options
                ? await documents.savePdfAs(stagedWorkingPath, options)
                : await documents.savePdfAs(stagedWorkingPath),
            validation,
        };
    } finally {
        await documents.cleanupFile(stagedWorkingPath).catch((cleanupError: unknown) => {
            BrowserLogger.warn('pdf-file', 'Failed to cleanup staged Save As working copy', {
                stagedWorkingPath,
                error: cleanupError,
            });
        });
    }
}
