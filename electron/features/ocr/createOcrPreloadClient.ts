import type {IpcRenderer} from 'electron';
import type {
    IOcrCapability,
    IOcrCompleteResult,
    IOcrErrorEnvelope,
    IOcrProgress,
    TOcrErrorCode,
    TOcrProgressPhase,
} from '@contracts/electronApiOcr';
import type { TDocumentRef } from '@contracts/documentRef';
import { isRecord } from '@contracts/runtimeGuards';
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
const OCR_ERROR_CODES = new Set<TOcrErrorCode>([
    'OCR_INVALID_PAYLOAD',
    'OCR_INTERNAL_ERROR',
    'OCR_QUEUE_BACKPRESSURE',
    'OCR_WORKER_UNAVAILABLE',
    'OCR_TOOLS_VALIDATION_FAILED',
]);
const OCR_PROGRESS_PHASES = new Set<TOcrProgressPhase>([
    'preparing',
    'model-prep',
    'pdf-prep',
    'dpi-inspection',
    'page-size-probing',
    'processing',
    'merging',
    'indexing',
]);

function buildMalformedCompleteResult(requestId: string, message = 'Malformed OCR completion payload'): IOcrCompleteResult {
    return {
        requestId,
        success: false,
        errors: [message],
        errorEnvelope: {
            code: 'OCR_INVALID_PAYLOAD',
            message,
            retryable: false,
            timestamp: Date.now(),
        },
    };
}

function assertRequestId(value: unknown, fieldName: string) {
    return assertNonEmptyString(value, fieldName, 128);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function decodeOcrProgress(payload: unknown): IOcrProgress | null {
    if (
        !isRecord(payload)
        || typeof payload.requestId !== 'string'
        || !isFiniteNumber(payload.currentPage)
        || !isFiniteNumber(payload.processedCount)
        || !isFiniteNumber(payload.totalPages)
    ) {
        return null;
    }
    if (
        payload.phase !== undefined
        && (
            typeof payload.phase !== 'string'
            || !OCR_PROGRESS_PHASES.has(payload.phase as TOcrProgressPhase)
        )
    ) {
        return null;
    }
    if (payload.phaseProgress !== undefined && !isFiniteNumber(payload.phaseProgress)) {
        return null;
    }
    if (payload.activePages !== undefined && (
        !Array.isArray(payload.activePages)
        || payload.activePages.some(page => !isFiniteNumber(page))
    )) {
        return null;
    }
    if (payload.languageCode !== undefined && typeof payload.languageCode !== 'string') {
        return null;
    }

    return {
        requestId: payload.requestId,
        currentPage: payload.currentPage,
        processedCount: payload.processedCount,
        totalPages: payload.totalPages,
        ...(payload.phase === undefined ? {} : {phase: payload.phase as NonNullable<IOcrProgress['phase']>}),
        ...(payload.phaseProgress === undefined ? {} : {phaseProgress: payload.phaseProgress}),
        ...(payload.activePages === undefined ? {} : {activePages: payload.activePages as number[]}),
        ...(payload.languageCode === undefined ? {} : {languageCode: payload.languageCode}),
    };
}

function decodeOcrErrorEnvelope(payload: unknown): IOcrErrorEnvelope | null {
    if (
        !isRecord(payload)
        || typeof payload.code !== 'string'
        || !OCR_ERROR_CODES.has(payload.code as TOcrErrorCode)
        || typeof payload.message !== 'string'
        || typeof payload.retryable !== 'boolean'
        || !isFiniteNumber(payload.timestamp)
    ) {
        return null;
    }
    if (payload.details !== undefined && typeof payload.details !== 'string') {
        return null;
    }

    return {
        code: payload.code as TOcrErrorCode,
        message: payload.message,
        retryable: payload.retryable,
        timestamp: payload.timestamp,
        ...(payload.details === undefined ? {} : {details: payload.details}),
    };
}

function decodeOcrCompleteResult(payload: unknown): IOcrCompleteResult | null {
    if (!isRecord(payload)) {
        return null;
    }
    if (typeof payload.requestId !== 'string') {
        return null;
    }

    if (
        typeof payload.success !== 'boolean'
        || !Array.isArray(payload.errors)
        || payload.errors.some(error => typeof error !== 'string')
    ) {
        return buildMalformedCompleteResult(payload.requestId);
    }
    if (payload.pdfPath !== undefined && typeof payload.pdfPath !== 'string') {
        return buildMalformedCompleteResult(payload.requestId);
    }
    if (payload.requiresCleanupAck !== undefined && typeof payload.requiresCleanupAck !== 'boolean') {
        return buildMalformedCompleteResult(payload.requestId);
    }
    const errorEnvelope = payload.errorEnvelope === undefined
        ? null
        : decodeOcrErrorEnvelope(payload.errorEnvelope);
    if (payload.errorEnvelope !== undefined && errorEnvelope === null) {
        return buildMalformedCompleteResult(payload.requestId, 'Malformed OCR completion error envelope');
    }
    const errors = payload.errors.map(error => error as string);

    return {
        requestId: payload.requestId,
        success: payload.success,
        errors,
        ...(payload.pdfPath === undefined ? {} : {pdfPath: payload.pdfPath}),
        ...(payload.requiresCleanupAck === undefined ? {} : {requiresCleanupAck: payload.requiresCleanupAck}),
        ...(errorEnvelope === null ? {} : {errorEnvelope}),
    };
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
            eventSubscriber.onDecodedPayload(OCR_EVENT_CHANNELS.progress, decodeOcrProgress, callback),

        onComplete: (callback: (result: IOcrCompleteResult) => void): (() => void) =>
            eventSubscriber.onDecodedPayload(OCR_EVENT_CHANNELS.complete, decodeOcrCompleteResult, callback),

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
