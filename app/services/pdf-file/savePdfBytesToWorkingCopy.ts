import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentSaveFailureResult,
    IPdfSerializedCommitCallbacks,
    IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';
import {
    getDocumentFilesCapability,
    getDocumentPdfCapability,
} from '@app/utils/platformDocuments';

function getStructuredSaveFailureErrors(result: IDocumentSaveFailureResult) {
    const validationErrors = result.validation?.errors.filter(error => error.length > 0) ?? [];
    if (validationErrors.length > 0) {
        return validationErrors;
    }

    if (result.message && result.message.length > 0) {
        return [result.message];
    }

    return result.reason === 'user-canceled' ? [] : [result.reason];
}

export async function savePdfBytesToWorkingCopy(
    workingPath: TDocumentRef,
    data: Uint8Array,
    options?: IPdfSerializedSaveOptions,
    commitCallbacks?: IPdfSerializedCommitCallbacks,
) {
    const documentFiles = getDocumentFilesCapability();
    if (typeof documentFiles.savePdfData === 'function') {
        return documentFiles.savePdfData(workingPath, data, options, commitCallbacks);
    }

    const validation = await getDocumentPdfCapability().validatePdfData(data);
    if (validation.isValid) {
        await commitCallbacks?.verifyBytesBeforeCommit?.(data);
        await commitCallbacks?.assertBeforeCommit?.();
        await documentFiles.writeFile(workingPath, data, options);
        const structuredSave = await documentFiles.saveFileStructured(workingPath, options);
        if (!structuredSave.ok) {
            return {
                ...validation,
                isValid: false,
                errors: getStructuredSaveFailureErrors(structuredSave),
            };
        }
    }
    return validation;
}
