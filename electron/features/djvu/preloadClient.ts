import type {IpcRenderer} from 'electron';
import type { IDjvuCapability } from '@contracts/electronApiDjvu';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import {
    DJVU_CHANNELS,
    DJVU_EVENT_CHANNELS,
} from '@electron/features/djvu/contract';
import {
    createIpcInvoker,
    createTypedIpcEventSubscriber,
} from '@electron/preload/ipcClient';

interface IDjvuEventMap {
    [DJVU_EVENT_CHANNELS.progress]: {
        jobId: string;
        phase: 'converting' | 'bookmarks' | 'loading';
        current?: number;
        total?: number;
        percent: number;
    };
    [DJVU_EVENT_CHANNELS.viewingReady]: {
        pdfPath: string;
        isPartial: boolean;
        jobId?: string;
    };
    [DJVU_EVENT_CHANNELS.viewingError]: {
        error: string;
        jobId?: string;
    };
    [DJVU_EVENT_CHANNELS.menuConvertToPdf]: undefined;
}

export function createDjvuPreloadClient(ipcRenderer: IpcRenderer): IDjvuCapability {
    const invoke = createIpcInvoker(ipcRenderer);
    const eventSubscriber = createTypedIpcEventSubscriber<IDjvuEventMap>(ipcRenderer);

    return {
        openForViewing: (djvuPath: string) =>
            invoke<Awaited<ReturnType<IDjvuCapability['openForViewing']>>>(DJVU_CHANNELS.openForViewing, djvuPath),
        releaseViewingPath: (djvuPath: string) =>
            invoke<Awaited<ReturnType<IDjvuCapability['releaseViewingPath']>>>(DJVU_CHANNELS.releaseViewingPath, djvuPath),
        convertToPdf: (djvuPath: string, outputPath: string, options: {
            subsample?: number;
            preserveBookmarks?: boolean;
        }) => invoke<Awaited<ReturnType<IDjvuCapability['convertToPdf']>>>(
            DJVU_CHANNELS.convertToPdf,
            djvuPath,
            outputPath,
            options,
        ),
        cancel: (jobId: string) => invoke<Awaited<ReturnType<IDjvuCapability['cancel']>>>(DJVU_CHANNELS.cancel, jobId),
        getInfo: (djvuPath: string) => invoke<Awaited<ReturnType<IDjvuCapability['getInfo']>>>(DJVU_CHANNELS.getInfo, djvuPath),
        estimateSizes: (djvuPath: string) => invoke<Awaited<ReturnType<IDjvuCapability['estimateSizes']>>>(DJVU_CHANNELS.estimateSizes, djvuPath),
        cleanupTemp: (tempPdfPath: string) => invoke<Awaited<ReturnType<IDjvuCapability['cleanupTemp']>>>(DJVU_CHANNELS.cleanupTemp, tempPdfPath),
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
        onMenuConvertToPdf: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DJVU_EVENT_CHANNELS.menuConvertToPdf, callback),
    };
}
