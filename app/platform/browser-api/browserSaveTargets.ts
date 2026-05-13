import type { TDocumentRef } from '@contracts/platformApi';
import {
    BROWSER_MAX_FULL_READ_BYTES,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
import {
    buildPdfSaveTypes,
    ensurePdfExtension,
} from '@app/platform/browser-api/common';
import { buildBrowserByteLimitError } from '@app/platform/browser-api/browserPlatformHelpers';
import {
    saveBytesToPickerOrDownload,
    writeDocumentRefToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';

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
