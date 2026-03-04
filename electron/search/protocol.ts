import type { TaggedUnion } from 'type-fest';

export interface ISearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

export interface ISearchMatch {
    pageNumber: number;
    pageMatchIndex: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt: ISearchExcerpt;
}

export interface ISearchResponse {
    results: ISearchMatch[];
    truncated: boolean;
}

export interface ISearchWorkerRequest {
    requestId: string;
    pdfPath: string;
    query: string;
    pageCount?: number;
}

type TSearchWorkerInboundByType = {
    search: {payload: ISearchWorkerRequest;};
    cancel: {requestId: string;};
    'reset-cache': Record<never, never>;
};

type TSearchWorkerOutboundByType = {
    progress: {
        requestId: string;
        processed: number;
        total: number;
    };
    complete: {
        requestId: string;
        response: ISearchResponse;
    };
    cancelled: {requestId: string;};
    error: {
        requestId: string;
        error: string;
    };
};

export type TSearchWorkerInboundMessage = TaggedUnion<'type', TSearchWorkerInboundByType>;
export type TSearchWorkerOutboundMessage = TaggedUnion<'type', TSearchWorkerOutboundByType>;
