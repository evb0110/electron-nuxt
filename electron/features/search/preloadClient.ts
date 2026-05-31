import type {IpcRenderer} from 'electron';
import type {
    IPdfSearchProgress,
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
    ISearchPreloadClient,
} from '@contracts/search';
import {
    SEARCH_CHANNELS,
    SEARCH_EVENT_CHANNELS,
    type ISearchEventMap,
    type ISearchInvokeMap,
} from '@electron/features/search/contract';
import {
    createTypedIpcEventSubscriber,
    createTypedIpcInvoker,
} from '@electron/preload/ipcClient';

export function createSearchPreloadClient(ipcRenderer: IpcRenderer): ISearchPreloadClient {
    const invoke = createTypedIpcInvoker<ISearchInvokeMap>(ipcRenderer);
    const eventSubscriber = createTypedIpcEventSubscriber<ISearchEventMap>(ipcRenderer);

    return {
        run: (
            pdfPath: string,
            query: string,
            options?: IPdfSearchRequestOptions,
        ): Promise<IPdfSearchResponse> => invoke(SEARCH_CHANNELS.search, {
            pdfPath,
            query,
            ...options,
        }),
        warmIndex: (
            pdfPath: string,
            options?: IPdfSearchRequestOptions,
        ): Promise<boolean> => invoke(SEARCH_CHANNELS.warmIndex, {
            pdfPath,
            ...options,
        }),
        cancel: (requestId?: string): Promise<{ canceled: boolean }> =>
            invoke(SEARCH_CHANNELS.cancel, requestId),
        onProgress: (callback: (progress: IPdfSearchProgress) => void): (() => void) =>
            eventSubscriber.onPayload(SEARCH_EVENT_CHANNELS.progress, callback),
        resetCache: (): Promise<boolean> => invoke(SEARCH_CHANNELS.resetCache),
    };
}
