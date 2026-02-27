export const SEARCH_CHANNELS = {
    search: 'pdf:search',
    cancel: 'pdf:search:cancel',
    resetCache: 'pdf:search:resetCache',
} as const;

export const SEARCH_EVENT_CHANNELS = {progress: 'pdf:search:progress'} as const;

interface IPdfSearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

interface IPdfSearchResult {
    pageNumber: number;
    pageMatchIndex?: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt: IPdfSearchExcerpt;
}

interface IPdfSearchResponse {
    results: IPdfSearchResult[];
    truncated: boolean;
}

interface IPdfSearchProgress {
    requestId: string;
    processed: number;
    total: number;
}

interface ISearchCapability {
    run: (
        pdfPath: string,
        query: string,
        options?: {
            requestId?: string;
            pageCount?: number;
        },
    ) => Promise<IPdfSearchResponse>;
    cancel: (requestId?: string) => Promise<{ canceled: boolean }>;
    onProgress: (callback: (progress: IPdfSearchProgress) => void) => () => void;
    resetCache: () => Promise<boolean>;
}
