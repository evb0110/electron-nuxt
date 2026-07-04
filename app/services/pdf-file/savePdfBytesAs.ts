import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPdfSaveAsOptions,
    IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';
import {
    getDocumentFilesCapability,
    getDocumentPdfCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';

export async function savePdfBytesAs(
    workingPath: TDocumentRef,
    data: Uint8Array,
    options?: IPdfSaveAsOptions,
    serializedSaveOptions?: IPdfSerializedSaveOptions,
) {
    const documentFiles = getDocumentFilesCapability();
    if (typeof documentFiles.savePdfDataAs === 'function') {
        if (serializedSaveOptions) {
            return documentFiles.savePdfDataAs(workingPath, data, options, serializedSaveOptions);
        }
        return options
            ? documentFiles.savePdfDataAs(workingPath, data, options)
            : documentFiles.savePdfDataAs(workingPath, data);
    }

    const validation = await getDocumentPdfCapability().validatePdfData(data);
    if (!validation.isValid) {
        return {
            path: null,
            validation,
        };
    }

    const documentWorkingCopy = getDocumentWorkingCopyCapability();
    const stagedWorkingPath = await documentWorkingCopy.createWorkingCopyFromData(
        getDocumentRefBaseName(workingPath) ?? 'document.pdf',
        data,
    );
    try {
        return {
            path: options
                ? await documentFiles.savePdfAs(stagedWorkingPath, options)
                : await documentFiles.savePdfAs(stagedWorkingPath),
            validation,
        };
    } finally {
        await documentWorkingCopy.cleanupFile(stagedWorkingPath).catch((cleanupError: unknown) => {
            BrowserLogger.warn('pdf-file', 'Failed to cleanup staged Save As working copy', {
                stagedWorkingPath,
                error: cleanupError,
            });
        });
    }
}
