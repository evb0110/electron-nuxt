import type {
    IpcRenderer,
    IpcRendererEvent,
} from 'electron';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from '@contracts/electron-api';
import {
    DJVU_CHANNELS,
    DJVU_EVENT_CHANNELS,
} from '@electron/features/djvu/contract';

function onNoArgEvent(ipcRenderer: IpcRenderer, channel: string, callback: IMenuEventCallback): IMenuEventUnsubscribe {
    const handler = (_event: IpcRendererEvent) => callback();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

export function createDjvuPreloadClient(ipcRenderer: IpcRenderer) {
    return {
        openForViewing: (djvuPath: string) => ipcRenderer.invoke(DJVU_CHANNELS.openForViewing, djvuPath),
        convertToPdf: (djvuPath: string, outputPath: string, options: {
            subsample?: number;
            preserveBookmarks?: boolean;
        }) => ipcRenderer.invoke(DJVU_CHANNELS.convertToPdf, djvuPath, outputPath, options),
        cancel: (jobId: string) => ipcRenderer.invoke(DJVU_CHANNELS.cancel, jobId),
        getInfo: (djvuPath: string) => ipcRenderer.invoke(DJVU_CHANNELS.getInfo, djvuPath),
        estimateSizes: (djvuPath: string) => ipcRenderer.invoke(DJVU_CHANNELS.estimateSizes, djvuPath),
        cleanupTemp: (tempPdfPath: string) => ipcRenderer.invoke(DJVU_CHANNELS.cleanupTemp, tempPdfPath),
        onProgress: (callback: (progress: {
            jobId: string;
            phase: 'converting' | 'bookmarks' | 'loading';
            current?: number;
            total?: number;
            percent: number;
        }) => void): (() => void) => {
            const handler = (_event: IpcRendererEvent, progress: {
                jobId: string;
                phase: 'converting' | 'bookmarks' | 'loading';
                current?: number;
                total?: number;
                percent: number;
            }) => callback(progress);
            ipcRenderer.on(DJVU_EVENT_CHANNELS.progress, handler);
            return () => ipcRenderer.removeListener(DJVU_EVENT_CHANNELS.progress, handler);
        },
        onViewingReady: (callback: (data: {
            pdfPath: string;
            isPartial: boolean;
            jobId?: string;
        }) => void): (() => void) => {
            const handler = (_event: IpcRendererEvent, data: {
                pdfPath: string;
                isPartial: boolean;
                jobId?: string;
            }) => callback(data);
            ipcRenderer.on(DJVU_EVENT_CHANNELS.viewingReady, handler);
            return () => ipcRenderer.removeListener(DJVU_EVENT_CHANNELS.viewingReady, handler);
        },
        onViewingError: (callback: (data: {
            error: string;
            jobId?: string;
        }) => void): (() => void) => {
            const handler = (_event: IpcRendererEvent, data: {
                error: string;
                jobId?: string;
            }) => callback(data);
            ipcRenderer.on(DJVU_EVENT_CHANNELS.viewingError, handler);
            return () => ipcRenderer.removeListener(DJVU_EVENT_CHANNELS.viewingError, handler);
        },
        onMenuConvertToPdf: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, DJVU_EVENT_CHANNELS.menuConvertToPdf, callback),
    };
}
