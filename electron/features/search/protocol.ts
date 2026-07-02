import type { TaggedUnion } from 'type-fest';
import type {
    IPdfSearchResponse,
    IPdfSearchResult,
} from '@contracts/search';

export type ISearchMatch = IPdfSearchResult;
export type ISearchResponse = IPdfSearchResponse;

export interface ISearchWorkerRequest {
    requestId: string;
    pdfPath: string;
    query: string;
    pageCount?: number;
    warmup?: boolean;
    matchCase?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
}

interface ISearchWorkerInboundByType {
    search: {payload: ISearchWorkerRequest;};
    cancel: {requestId: string;};
    'reset-cache': Record<never, never>;
    'reset-state': Record<never, never>;
}

interface ISearchWorkerOutboundByType {
    progress: {
        requestId: string;
        processed: number;
        total: number;
        results?: ISearchMatch[];
        truncated?: boolean;
        canceled?: boolean;
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
}

type TSearchWorkerInboundByType = {
    [K in keyof ISearchWorkerInboundByType]: ISearchWorkerInboundByType[K];
};

type TSearchWorkerOutboundByType = {
    [K in keyof ISearchWorkerOutboundByType]: ISearchWorkerOutboundByType[K];
};

export type TSearchWorkerInboundMessage = TaggedUnion<'type', TSearchWorkerInboundByType>;
export type TSearchWorkerOutboundMessage = TaggedUnion<'type', TSearchWorkerOutboundByType>;
