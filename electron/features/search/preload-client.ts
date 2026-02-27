import type {
    IpcRenderer,
    IpcRendererEvent,
} from 'electron';
import {
    SEARCH_CHANNELS,
    SEARCH_EVENT_CHANNELS,
} from '@electron/features/search/contract';

export function createSearchPreloadClient(ipcRenderer: IpcRenderer) {
    return {
        run: (
            pdfPath: string,
            query: string,
            options?: {
                requestId?: string;
                pageCount?: number;
            },
        ) => ipcRenderer.invoke(SEARCH_CHANNELS.search, {
            pdfPath,
            query,
            ...options,
        }),
        cancel: (requestId?: string) => ipcRenderer.invoke(SEARCH_CHANNELS.cancel, requestId),
        onProgress: (callback: (progress: {
            requestId: string;
            processed: number;
            total: number;
        }) => void): (() => void) => {
            const handler = (_event: IpcRendererEvent, progress: {
                requestId: string;
                processed: number;
                total: number;
            }) => callback(progress);
            ipcRenderer.on(SEARCH_EVENT_CHANNELS.progress, handler);
            return () => ipcRenderer.removeListener(SEARCH_EVENT_CHANNELS.progress, handler);
        },
        resetCache: () => ipcRenderer.invoke(SEARCH_CHANNELS.resetCache),
    };
}
