import type {
    IPdfSearchProgress,
    IPdfSearchRequestOptions,
    ISearchPreloadClient,
} from '@contracts/search';

export const SEARCH_CHANNELS = {
    search: 'pdf:search',
    warmIndex: 'pdf:search:warmIndex',
    cancel: 'pdf:search:cancel',
    resetCache: 'pdf:search:resetCache',
} as const;

export const SEARCH_EVENT_CHANNELS = {progress: 'pdf:search:progress'} as const;

interface ISearchRequest extends IPdfSearchRequestOptions {
    pdfPath: string;
    query: string;
}

interface IWarmIndexRequest extends IPdfSearchRequestOptions {pdfPath: string;}

export interface ISearchInvokeMap {
    [SEARCH_CHANNELS.search]: {
        args: [request: ISearchRequest];
        result: Awaited<ReturnType<ISearchPreloadClient['run']>>;
    };
    [SEARCH_CHANNELS.warmIndex]: {
        args: [request: IWarmIndexRequest];
        result: Awaited<ReturnType<ISearchPreloadClient['warmIndex']>>;
    };
    [SEARCH_CHANNELS.cancel]: {
        args: [requestId?: string];
        result: Awaited<ReturnType<ISearchPreloadClient['cancel']>>;
    };
    [SEARCH_CHANNELS.resetCache]: {
        args: [];
        result: Awaited<ReturnType<ISearchPreloadClient['resetCache']>>;
    };
}

export interface ISearchEventMap {[SEARCH_EVENT_CHANNELS.progress]: IPdfSearchProgress;}
