import type {IpcRenderer} from 'electron';
import type { IOcrCapability } from '@contracts/electron-api';
import type { TDocumentRef } from '@contracts/platform-api';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
} from '@contracts/ipc-assertions';
import {
    OCR_CHANNELS,
    OCR_EVENT_CHANNELS,
} from '@electron/features/ocr/contract';
import {
    createIpcInvoker,
    createTypedIpcEventSubscriber,
} from '@electron/preload/ipc-client';

function assertRequestId(value: unknown, fieldName: string) {
    return assertNonEmptyString(value, fieldName, 128);
}

interface IOcrEventMap {
    [OCR_EVENT_CHANNELS.progress]: {
        requestId: string;
        currentPage: number;
        processedCount: number;
        totalPages: number;
    };
    [OCR_EVENT_CHANNELS.complete]: {
        requestId: string;
        success: boolean;
        pdfPath?: TDocumentRef;
        requiresCleanupAck?: boolean;
        errors: string[];
    };
}

type TOcrPreprocessing = IOcrCapability['preprocessing'];

export function createOcrPreloadClient(ipcRenderer: IpcRenderer): IOcrCapability {
    const invoke = createIpcInvoker(ipcRenderer);
    const eventSubscriber = createTypedIpcEventSubscriber<IOcrEventMap>(ipcRenderer);

    return {
        recognize: (request: {
            pageNumber: number;
            imageData: Uint8Array;
            languages: string[];
        }) => invoke<Awaited<ReturnType<IOcrCapability['recognize']>>>(OCR_CHANNELS.recognize, request),

        recognizeBatch: (
            pages: Array<{
                pageNumber: number;
                imageData: Uint8Array;
                languages: string[];
            }>,
            requestId: string,
        ) => invoke<Awaited<ReturnType<IOcrCapability['recognizeBatch']>>>(OCR_CHANNELS.recognizeBatch, pages, requestId),

        cancel: (requestId: string) => invoke<Awaited<ReturnType<IOcrCapability['cancel']>>>(OCR_CHANNELS.cancel, requestId),

        getLanguages: () => invoke<Awaited<ReturnType<IOcrCapability['getLanguages']>>>(OCR_CHANNELS.getLanguages),

        installLanguages: (languages: string[], requestId: string) => Promise.resolve({
            started: true,
            jobId: assertRequestId(requestId, 'ocrInstallLanguages.requestId'),
            installed: languages,
            errors: [],
        }),

        acknowledgeResultFile: (requestId: string, pdfPath?: TDocumentRef) =>
            invoke<Awaited<ReturnType<IOcrCapability['acknowledgeResultFile']>>>(
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
        ) => invoke<Awaited<ReturnType<IOcrCapability['createSearchablePdf']>>>(
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
            validate: () => invoke<Awaited<ReturnType<TOcrPreprocessing['validate']>>>(OCR_CHANNELS.preprocessingValidate),
            preprocessPage: (imageData: Uint8Array, usePreprocessing: boolean) =>
                invoke<Awaited<ReturnType<TOcrPreprocessing['preprocessPage']>>>(
                    OCR_CHANNELS.preprocessingPreprocessPage,
                    imageData,
                    usePreprocessing,
                ),
        },
    };
}
