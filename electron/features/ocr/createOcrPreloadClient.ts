import type {IpcRenderer} from 'electron';
import type {
    IOcrCapability,
    IOcrProgress,
} from '@contracts/electronApiOcr';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
} from '@contracts/ipcAssertions';
import {
    OCR_CHANNELS,
    OCR_EVENT_CHANNELS,
    type IOcrEventMap,
    type IOcrInvokeMap,
} from '@electron/features/ocr/contract';
import {
    createTypedIpcEventSubscriber,
    createTypedIpcInvoker,
} from '@electron/preload/ipcClient';

const OCR_LANGUAGE_INSTALL_UNAVAILABLE = 'OCR language installation is not available from the renderer; validateTools only reports installed languages.';

function assertRequestId(value: unknown, fieldName: string) {
    return assertNonEmptyString(value, fieldName, 128);
}

export function createOcrPreloadClient(ipcRenderer: IpcRenderer): IOcrCapability {
    const invoke = createTypedIpcInvoker<IOcrInvokeMap>(ipcRenderer);
    const eventSubscriber = createTypedIpcEventSubscriber<IOcrEventMap>(ipcRenderer);

    return {
        recognize: (request: {
            pageNumber: number;
            imageData: Uint8Array;
            languages: string[];
        }) => invoke(OCR_CHANNELS.recognize, request),

        recognizeBatch: (
            pages: Array<{
                pageNumber: number;
                imageData: Uint8Array;
                languages: string[];
            }>,
            requestId,
        ) => invoke(OCR_CHANNELS.recognizeBatch, pages, requestId),

        cancel: (requestId) => invoke(OCR_CHANNELS.cancel, requestId),

        getLanguages: () => invoke(OCR_CHANNELS.getLanguages),

        validateTools: () => invoke(OCR_CHANNELS.validateTools),

        installLanguages: async (languages, requestId) => {
            const checkedRequestId = assertRequestId(requestId, 'ocrInstallLanguages.requestId');
            const validation = await invoke(OCR_CHANNELS.validateTools);
            return {
                started: false,
                jobId: checkedRequestId,
                installed: [],
                errors: [
                    OCR_LANGUAGE_INSTALL_UNAVAILABLE,
                    ...validation.errors,
                ],
                error: OCR_LANGUAGE_INSTALL_UNAVAILABLE,
                ...(validation.errorEnvelope ? { errorEnvelope: validation.errorEnvelope } : {}),
            };
        },

        acknowledgeResultFile: (requestId, pdfPath?: TDocumentRef) =>
            invoke(
                OCR_CHANNELS.acknowledgeResultFile,
                assertRequestId(requestId, 'ocrAcknowledgeResultFile.requestId'),
                assertOptionalAbsolutePath(pdfPath, 'ocrAcknowledgeResultFile.pdfPath'),
            ),

        createSearchablePdf: (
            sourcePdfPath,
            pages,
            requestId,
            renderDpiOrOptions,
        ) => invoke(
            OCR_CHANNELS.createSearchablePdf,
            assertAbsolutePath(sourcePdfPath, 'ocrCreateSearchablePdf.sourcePdfPath'),
            pages,
            assertRequestId(requestId, 'ocrCreateSearchablePdf.requestId'),
            renderDpiOrOptions,
        ),

        onProgress: (callback: (progress: IOcrProgress) => void): (() => void) =>
            eventSubscriber.onPayload(OCR_EVENT_CHANNELS.progress, callback),

        onComplete: (callback: (result: {
            requestId: string;
            success: boolean;
            pdfPath?: TDocumentRef;
            requiresCleanupAck?: boolean;
            errors: string[];
        }) => void): (() => void) => eventSubscriber.onPayload(OCR_EVENT_CHANNELS.complete, callback),

        preprocessing: {
            validate: () => invoke(OCR_CHANNELS.preprocessingValidate),
            preprocessPage: (imageData, usePreprocessing) =>
                invoke(
                    OCR_CHANNELS.preprocessingPreprocessPage,
                    imageData,
                    usePreprocessing,
                ),
        },
    };
}
