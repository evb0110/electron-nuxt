import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentMutationRevisionOptions,
    TDocumentSaveResult,
} from '@contracts/electronApiDocuments';
import {
    BROWSER_MAX_FULL_READ_BYTES,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
import { buildPdfSaveTypes } from '@app/platform/browser-api/browserFileAccepts';
import { ensurePdfExtension } from '@app/platform/browser-api/browserFileName';
import { buildBrowserByteLimitError } from '@app/platform/browser-api/browserPlatformHelpers';
import {
    saveBytesToPickerOrDownload,
    writeDocumentRefToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import { getErrorMessage } from '@app/utils/error';

function buildBrowserLargeJobError(
    label: string,
    maxBytes: number,
    hint?: string,
) {
    return buildBrowserByteLimitError(
        label,
        maxBytes,
        'inputs',
        hint,
    );
}

export async function assertBrowserPathWithinFullReadBudget(
    path: string,
    label: string,
    hint?: string,
) {
    const { size } = await browserDocumentStore.stat(path);
    if (size > BROWSER_MAX_FULL_READ_BYTES) {
        throw buildBrowserLargeJobError(label, BROWSER_MAX_FULL_READ_BYTES, hint);
    }
}

export async function saveWorkingBytesToSource(
    workingCopyPath: TDocumentRef,
    getBrowserLargeSaveHandleHint: () => string,
) {
    const sourceRef = await browserDocumentStore.getSourceRef(workingCopyPath);
    const saveTarget = await browserDocumentStore.getSaveTarget(sourceRef);

    if (saveTarget.saveHandle) {
        await writeDocumentRefToHandle(saveTarget.saveHandle, workingCopyPath);
        const { size } = await browserDocumentStore.stat(workingCopyPath);
        await browserDocumentStore.replaceWithHandleBackedDocument(sourceRef, {
            fileSize: size,
            saveHandle: saveTarget.saveHandle,
            saveName: saveTarget.saveName,
        });
        await browserDocumentStore.assignSaveTarget(
            sourceRef,
            saveTarget.saveName,
            saveTarget.saveKind,
            saveTarget.saveHandle,
        );
    } else {
        await assertBrowserPathWithinFullReadBudget(
            workingCopyPath,
            'Saving documents',
            getBrowserLargeSaveHandleHint(),
        );
        const bytes = await browserDocumentStore.read(workingCopyPath);
        const saveResult = await saveBytesToPickerOrDownload(bytes, {
            suggestedName: ensurePdfExtension(saveTarget.saveName),
            mimeType: 'application/pdf',
            pickerTypes: buildPdfSaveTypes(),
            downloadFallbackLabel: 'Saving documents',
        });

        if (saveResult.canceled) {
            return false;
        }

        await browserDocumentStore.write(sourceRef, bytes);
        await browserDocumentStore.assignSaveTarget(
            sourceRef,
            ensurePdfExtension(saveResult.fileName),
            'pdf',
            saveResult.handle,
        );
    }

    await browserDocumentStore.touchRecentFile(sourceRef);
    return true;
}

export async function saveWorkingBytesToSourceStructured(
    workingCopyPath: TDocumentRef,
    getBrowserLargeSaveHandleHint: () => string,
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<TDocumentSaveResult> {
    try {
        await browserDocumentStore.assertDocumentRevisionCurrent(
            workingCopyPath,
            revisionOptions?.expectedDocumentRevisionToken,
        );
        const saved = await saveWorkingBytesToSource(workingCopyPath, getBrowserLargeSaveHandleHint);
        if (!saved) {
            return {
                ok: false,
                reason: 'user-canceled',
                externalWriteCommitted: false,
                validation: null,
            };
        }
        return {
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: true,
            validation: null,
        };
    } catch (error) {
        return {
            ok: false,
            reason: 'write-failed',
            message: getErrorMessage(error),
            externalWriteCommitted: false,
            validation: null,
        };
    }
}
