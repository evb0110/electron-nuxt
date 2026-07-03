import type {IpcRenderer} from 'electron';
import type {
    IDjvuCapability,
    IDjvuConvertOptions,
    IDjvuProgress,
    IDjvuPagePreviewOptions,
    IDjvuViewingErrorEvent,
    IDjvuViewingReadyEvent,
} from '@contracts/electronApiDjvu';
import type {
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    DJVU_CHANNELS,
    DJVU_EVENT_CHANNELS,
    type IDjvuEventMap,
    type IDjvuInvokeMap,
} from '@electron/features/djvu/contract';
import {
    createTypedIpcEventSubscriber,
    createTypedIpcInvoker,
} from '@electron/preload/ipcClient';

const DJVU_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1000;
const DJVU_INVOKE_TIMEOUT_MS_BY_CHANNEL = {
    [DJVU_CHANNELS.openForViewing]: DJVU_NATIVE_IPC_TIMEOUT_MS,
    [DJVU_CHANNELS.convertToPdf]: DJVU_NATIVE_IPC_TIMEOUT_MS,
    [DJVU_CHANNELS.getInfo]: DJVU_NATIVE_IPC_TIMEOUT_MS,
    [DJVU_CHANNELS.getPageSizes]: DJVU_NATIVE_IPC_TIMEOUT_MS,
    [DJVU_CHANNELS.renderPagePreview]: DJVU_NATIVE_IPC_TIMEOUT_MS,
    [DJVU_CHANNELS.estimateSizes]: DJVU_NATIVE_IPC_TIMEOUT_MS,
} as const;


function decodeDjvuProgress(payload: unknown): IDjvuProgress | null {
    if (
        !isRecord(payload)
        || typeof payload.jobId !== 'string'
        || !isFiniteNumber(payload.percent)
        || (
            payload.phase !== 'converting'
            && payload.phase !== 'bookmarks'
            && payload.phase !== 'optimizing'
            && payload.phase !== 'loading'
        )
        || (payload.current !== undefined && !isFiniteNumber(payload.current))
        || (payload.total !== undefined && !isFiniteNumber(payload.total))
    ) {
        return null;
    }

    return {
        jobId: payload.jobId,
        phase: payload.phase,
        percent: payload.percent,
        ...(payload.current === undefined ? {} : { current: payload.current }),
        ...(payload.total === undefined ? {} : { total: payload.total }),
    };
}

function decodeDjvuViewingReady(payload: unknown): IDjvuViewingReadyEvent | null {
    if (
        !isRecord(payload)
        || typeof payload.pdfPath !== 'string'
        || typeof payload.isPartial !== 'boolean'
        || (payload.jobId !== undefined && typeof payload.jobId !== 'string')
    ) {
        return null;
    }

    return {
        pdfPath: payload.pdfPath,
        isPartial: payload.isPartial,
        ...(payload.jobId === undefined ? {} : { jobId: payload.jobId }),
    };
}

function decodeDjvuViewingError(payload: unknown): IDjvuViewingErrorEvent | null {
    if (
        !isRecord(payload)
        || typeof payload.error !== 'string'
        || (payload.jobId !== undefined && typeof payload.jobId !== 'string')
    ) {
        return null;
    }

    return {
        error: payload.error,
        ...(payload.jobId === undefined ? {} : { jobId: payload.jobId }),
    };
}

function normalizeDjvuPagePreviewOptions(options: IDjvuPagePreviewOptions | undefined) {
    if (options === undefined) {
        return undefined;
    }
    if (!isRecord(options)) {
        throw new TypeError('renderPagePreview.options must be an object');
    }

    const normalizedOptions: IDjvuPagePreviewOptions = {};
    const subsample = options.subsample;
    if (subsample !== undefined) {
        if (typeof subsample !== 'number' || !Number.isInteger(subsample) || subsample < 1) {
            throw new TypeError('renderPagePreview.options.subsample must be a positive integer');
        }
        normalizedOptions.subsample = subsample;
    }
    const previewRequestId = options.previewRequestId;
    if (previewRequestId !== undefined) {
        if (typeof previewRequestId !== 'string' || previewRequestId.trim() === '') {
            throw new TypeError('renderPagePreview.options.previewRequestId must be a non-empty string');
        }
        normalizedOptions.previewRequestId = previewRequestId.trim();
    }
    return normalizedOptions;
}

export function createDjvuPreloadClient(ipcRenderer: IpcRenderer): IDjvuCapability {
    const invoke = createTypedIpcInvoker<IDjvuInvokeMap>(ipcRenderer, {invokeTimeoutMsByChannel: DJVU_INVOKE_TIMEOUT_MS_BY_CHANNEL});
    const eventSubscriber = createTypedIpcEventSubscriber<IDjvuEventMap>(ipcRenderer);

    return {
        openForViewing: (djvuPath: TDocumentRef) =>
            invoke(DJVU_CHANNELS.openForViewing, djvuPath),
        releaseViewingPath: (djvuPath: TDocumentRef) =>
            invoke(DJVU_CHANNELS.releaseViewingPath, djvuPath),
        convertToPdf: (
            djvuPath: TDocumentRef,
            outputPath: string,
            options: IDjvuConvertOptions,
        ) => invoke(
            DJVU_CHANNELS.convertToPdf,
            djvuPath,
            outputPath,
            options,
        ),
        cancel: (jobId: string) => invoke(DJVU_CHANNELS.cancel, jobId),
        getInfo: (djvuPath: TDocumentRef) => invoke(DJVU_CHANNELS.getInfo, djvuPath),
        getPageSizes: (djvuPath: TDocumentRef) => invoke(DJVU_CHANNELS.getPageSizes, djvuPath),
        renderPagePreview: (
            djvuPath: TDocumentRef,
            pageNumber: number,
            options?: IDjvuPagePreviewOptions,
        ) =>
            invoke(DJVU_CHANNELS.renderPagePreview, djvuPath, pageNumber, normalizeDjvuPagePreviewOptions(options)),
        estimateSizes: (djvuPath: TDocumentRef) => invoke(DJVU_CHANNELS.estimateSizes, djvuPath),
        cleanupTemp: (tempPdfPath: TDocumentRef) => invoke(DJVU_CHANNELS.cleanupTemp, tempPdfPath),
        onProgress: (callback: (progress: IDjvuProgress) => void): (() => void) =>
            eventSubscriber.onDecodedPayload(DJVU_EVENT_CHANNELS.progress, decodeDjvuProgress, callback),
        onViewingReady: (callback: (data: IDjvuViewingReadyEvent) => void): (() => void) =>
            eventSubscriber.onDecodedPayload(DJVU_EVENT_CHANNELS.viewingReady, decodeDjvuViewingReady, callback),
        onViewingError: (callback: (data: IDjvuViewingErrorEvent) => void): (() => void) =>
            eventSubscriber.onDecodedPayload(DJVU_EVENT_CHANNELS.viewingError, decodeDjvuViewingError, callback),
        onMenuConvertToPdf: (callback: TMenuEventCallback): TMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DJVU_EVENT_CHANNELS.menuConvertToPdf, callback),
    };
}
