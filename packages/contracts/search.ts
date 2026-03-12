export interface IPdfSearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

export interface IPdfSearchResult {
    pageNumber: number;
    pageMatchIndex: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt: IPdfSearchExcerpt;
}

export interface IPdfSearchResponse {
    results: IPdfSearchResult[];
    truncated: boolean;
}

export interface IPdfSearchProgress {
    requestId: string;
    processed: number;
    total: number;
}

export interface IPdfSearchRequestOptions {
    requestId?: string;
    pageCount?: number;
}

export interface ISearchPreloadClient {
    run: (
        pdfPath: string,
        query: string,
        options?: IPdfSearchRequestOptions,
    ) => Promise<IPdfSearchResponse>;
    warmIndex: (
        pdfPath: string,
        options?: IPdfSearchRequestOptions,
    ) => Promise<boolean>;
    cancel: (requestId?: string) => Promise<{ canceled: boolean }>;
    onProgress: (callback: (progress: IPdfSearchProgress) => void) => (() => void);
    resetCache: () => Promise<boolean>;
}
