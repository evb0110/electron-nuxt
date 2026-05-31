import type {IpcRenderer} from 'electron';
import type { IOcrCapability } from '@contracts/electronApiOcr';
import type { TDocumentRef } from '@contracts/platformApi';
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
            requestId: string,
        ) => invoke(OCR_CHANNELS.recognizeBatch, pages, requestId),

        cancel: (requestId: string) => invoke(OCR_CHANNELS.cancel, requestId),

        getLanguages: () => invoke(OCR_CHANNELS.getLanguages),

        installLanguages: (languages: string[], requestId: string) => Promise.resolve({
            started: true,
            jobId: assertRequestId(requestId, 'ocrInstallLanguages.requestId'),
            installed: languages,
            errors: [],
        }),

        acknowledgeResultFile: (requestId: string, pdfPath?: TDocumentRef) =>
            invoke(
                OCR_CHANNELS.acknowledgeResultFile,
                assertRequestId(requestId, 'ocrAcknowledgeResultFile.requestId'),
                assertOptionalAbsolutePath(pdfPath, 'ocrAcknowledgeResultFile.pdfPath'),
            ),

        createSearchablePdf: (
            sourcePdfPath: string,
            pages: Array<{
                pageNumber: number;
                languages: string[];
            }>,
            requestId: string,
            renderDpi?: number,
        ) => invoke(
            OCR_CHANNELS.createSearchablePdf,
            assertAbsolutePath(sourcePdfPath, 'ocrCreateSearchablePdf.sourcePdfPath'),
            pages,
            assertRequestId(requestId, 'ocrCreateSearchablePdf.requestId'),
            renderDpi,
        ),

        onProgress: (callback: (progress: {
            requestId: string;
            currentPage: number;
            processedCount: number;
            totalPages: number;
        }) => void): (() => void) => eventSubscriber.onPayload(OCR_EVENT_CHANNELS.progress, callback),

        onComplete: (callback: (result: {
            requestId: string;
            success: boolean;
            pdfPath?: TDocumentRef;
            requiresCleanupAck?: boolean;
            errors: string[];
        }) => void): (() => void) => eventSubscriber.onPayload(OCR_EVENT_CHANNELS.complete, callback),

        preprocessing: {
            validate: () => invoke(OCR_CHANNELS.preprocessingValidate),
            preprocessPage: (imageData: Uint8Array, usePreprocessing: boolean) =>
                invoke(
                    OCR_CHANNELS.preprocessingPreprocessPage,
                    imageData,
                    usePreprocessing,
                ),
        },
    };
}
