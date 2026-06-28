import type { WebContents } from 'electron';
import type { ISearchResponse } from '@electron/features/search/protocol';

export interface ISearchOperationContext {
    sender: WebContents;
    senderId: number;
}

export interface ISearchSenderContext {
    sender: WebContents;
    senderId?: number;
}

export interface ISearchService {
    search: (context: ISearchOperationContext, request: unknown) => Promise<ISearchResponse>;
    warmIndex: (context: ISearchOperationContext, request: unknown) => Promise<boolean>;
    cancel: (context: ISearchOperationContext, requestId?: unknown) => { canceled: boolean };
    resetCache: () => boolean;
    cleanupAll: (reason: string) => void;
}
