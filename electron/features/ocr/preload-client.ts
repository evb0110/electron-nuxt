import type {
    IpcRenderer,
    IpcRendererEvent,
} from 'electron';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
} from '@contracts/ipc-assertions';
import {
    OCR_CHANNELS,
    OCR_EVENT_CHANNELS,
} from '@electron/features/ocr/contract';

function assertRequestId(value: unknown, fieldName: string) {
    return assertNonEmptyString(value, fieldName, 128);
}

export function createOcrPreloadClient(ipcRenderer: IpcRenderer) {
    return {
        recognize: (request: {
            pageNumber: number;
            imageData: Uint8Array;
            languages: string[];
        }) => ipcRenderer.invoke(OCR_CHANNELS.recognize, request),

        recognizeBatch: (
            pages: Array<{
                pageNumber: number;
                imageData: Uint8Array;
                languages: string[];
            }>,
            requestId: string,
        ) => ipcRenderer.invoke(OCR_CHANNELS.recognizeBatch, pages, requestId),

        cancel: (requestId: string) => ipcRenderer.invoke(OCR_CHANNELS.cancel, requestId),

        getLanguages: () => ipcRenderer.invoke(OCR_CHANNELS.getLanguages),

        acknowledgeResultFile: (requestId: string, pdfPath?: string) => ipcRenderer.invoke(
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
        ) => ipcRenderer.invoke(
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
        }) => void): (() => void) => {
            const handler = (_event: IpcRendererEvent, progress: {
                requestId: string;
                currentPage: number;
                processedCount: number;
                totalPages: number;
            }) => callback(progress);
            ipcRenderer.on(OCR_EVENT_CHANNELS.progress, handler);
            return () => ipcRenderer.removeListener(OCR_EVENT_CHANNELS.progress, handler);
        },

        onComplete: (callback: (result: {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
        }) => void): (() => void) => {
            const handler = (_event: IpcRendererEvent, result: {
                requestId: string;
                success: boolean;
                pdfPath?: string;
                requiresCleanupAck?: boolean;
                errors: string[];
            }) => callback(result);
            ipcRenderer.on(OCR_EVENT_CHANNELS.complete, handler);
            return () => ipcRenderer.removeListener(OCR_EVENT_CHANNELS.complete, handler);
        },

        preprocessing: {
            validate: () => ipcRenderer.invoke(OCR_CHANNELS.preprocessingValidate),
            preprocessPage: (imageData: Uint8Array, usePreprocessing: boolean) =>
                ipcRenderer.invoke(OCR_CHANNELS.preprocessingPreprocessPage, imageData, usePreprocessing),
        },
    };
}
