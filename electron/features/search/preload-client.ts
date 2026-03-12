import type {
    IpcRenderer,
    IpcRendererEvent,
} from 'electron';
import type {
    IPdfSearchProgress,
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
    ISearchPreloadClient,
} from '@contracts/search';
import {
    SEARCH_CHANNELS,
    SEARCH_EVENT_CHANNELS,
} from '@electron/features/search/contract';

export function createSearchPreloadClient(ipcRenderer: IpcRenderer): ISearchPreloadClient {
    return {
        run: (
            pdfPath: string,
            query: string,
            options?: IPdfSearchRequestOptions,
        ): Promise<IPdfSearchResponse> => ipcRenderer.invoke(SEARCH_CHANNELS.search, {
            pdfPath,
            query,
            ...options,
        }),
        warmIndex: (
            pdfPath: string,
            options?: IPdfSearchRequestOptions,
        ): Promise<boolean> => ipcRenderer.invoke(SEARCH_CHANNELS.warmIndex, {
            pdfPath,
            ...options,
        }),
        cancel: (requestId?: string): Promise<{ canceled: boolean }> =>
            ipcRenderer.invoke(SEARCH_CHANNELS.cancel, requestId),
        onProgress: (callback: (progress: IPdfSearchProgress) => void): (() => void) => {
            const handler = (_event: IpcRendererEvent, progress: IPdfSearchProgress) => callback(progress);
            ipcRenderer.on(SEARCH_EVENT_CHANNELS.progress, handler);
            return () => ipcRenderer.removeListener(SEARCH_EVENT_CHANNELS.progress, handler);
        },
        resetCache: (): Promise<boolean> => ipcRenderer.invoke(SEARCH_CHANNELS.resetCache),
    };
}
