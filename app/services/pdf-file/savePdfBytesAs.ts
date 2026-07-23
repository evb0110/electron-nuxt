import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPdfSaveAsOptions,
    IPdfSerializedCommitCallbacks,
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
    commitCallbacks?: IPdfSerializedCommitCallbacks,
) {
    const documentFiles = getDocumentFilesCapability();
    if (typeof documentFiles.savePdfDataAs === 'function') {
        return documentFiles.savePdfDataAs(
            workingPath,
            data,
            options,
            serializedSaveOptions,
            commitCallbacks,
        );
    }

    const validation = await getDocumentPdfCapability().validatePdfData(data);
    if (!validation.isValid) {
        return {
            path: null,
            validation,
        };
    }
    await commitCallbacks?.verifyBytesBeforeCommit?.(data);

    const documentWorkingCopy = getDocumentWorkingCopyCapability();
    const stagedWorkingPath = await documentWorkingCopy.createWorkingCopyFromData(
        getDocumentRefBaseName(workingPath) ?? 'document.pdf',
        data,
    );
    try {
        const stagedRevision = await documentFiles.getDocumentRevision(stagedWorkingPath);
        await commitCallbacks?.assertBeforeCommit?.();
        return {
            path: await documentFiles.savePdfAs(stagedWorkingPath, options, { expectedDocumentRevisionToken: stagedRevision.token }),
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
