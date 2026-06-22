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
import { isRecord } from '@contracts/runtimeGuards';
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

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

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

export function createDjvuPreloadClient(ipcRenderer: IpcRenderer): IDjvuCapability {
    const invoke = createTypedIpcInvoker<IDjvuInvokeMap>(ipcRenderer);
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
            invoke(DJVU_CHANNELS.renderPagePreview, djvuPath, pageNumber, options),
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
