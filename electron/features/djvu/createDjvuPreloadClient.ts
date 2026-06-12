import type {IpcRenderer} from 'electron';
import type { IDjvuCapability } from '@contracts/electronApiDjvu';
import type { IMenuEventUnsubscribe } from '@contracts/electronApiCommon';
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

export function createDjvuPreloadClient(ipcRenderer: IpcRenderer): IDjvuCapability {
    const invoke = createTypedIpcInvoker<IDjvuInvokeMap>(ipcRenderer);
    const eventSubscriber = createTypedIpcEventSubscriber<IDjvuEventMap>(ipcRenderer);

    return {
        openForViewing: (djvuPath) =>
            invoke(DJVU_CHANNELS.openForViewing, djvuPath),
        releaseViewingPath: (djvuPath) =>
            invoke(DJVU_CHANNELS.releaseViewingPath, djvuPath),
        convertToPdf: (djvuPath, outputPath, options: {
            subsample?: number;
            preserveBookmarks?: boolean;
        }) => invoke(
            DJVU_CHANNELS.convertToPdf,
            djvuPath,
            outputPath,
            options,
        ),
        cancel: (jobId) => invoke(DJVU_CHANNELS.cancel, jobId),
        getInfo: (djvuPath) => invoke(DJVU_CHANNELS.getInfo, djvuPath),
        getPageSizes: (djvuPath) => invoke(DJVU_CHANNELS.getPageSizes, djvuPath),
        renderPagePreview: (djvuPath, pageNumber, options) =>
            invoke(DJVU_CHANNELS.renderPagePreview, djvuPath, pageNumber, options),
        estimateSizes: (djvuPath) => invoke(DJVU_CHANNELS.estimateSizes, djvuPath),
        cleanupTemp: (tempPdfPath) => invoke(DJVU_CHANNELS.cleanupTemp, tempPdfPath),
        onProgress: (callback: (progress: {
            jobId: string;
            phase: 'converting' | 'bookmarks' | 'loading';
            current?: number;
            total?: number;
            percent: number;
        }) => void): (() => void) => eventSubscriber.onPayload(DJVU_EVENT_CHANNELS.progress, callback),
        onViewingReady: (callback: (data: {
            pdfPath: string;
            isPartial: boolean;
            jobId?: string;
        }) => void): (() => void) => eventSubscriber.onPayload(DJVU_EVENT_CHANNELS.viewingReady, callback),
        onViewingError: (callback: (data: {
            error: string;
            jobId?: string;
        }) => void): (() => void) => eventSubscriber.onPayload(DJVU_EVENT_CHANNELS.viewingError, callback),
        onMenuConvertToPdf: (callback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DJVU_EVENT_CHANNELS.menuConvertToPdf, callback),
    };
}
