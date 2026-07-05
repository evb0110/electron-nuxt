import type { TSplitPayload } from '@contracts/windowTabs';
import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';

export interface IWorkspaceSplitCacheSessionState {
    sessionId: string;
    sessionRevision: number;
    documentRef: TDocumentRef | null;
    documentBackend?: TDocumentBackend;
    documentInstanceId?: TDocumentInstanceId | null;
    documentRevisionToken?: TDocumentRevisionToken;
}

export interface IWorkspaceSplitCacheLike {
    set: (
        tabId: string,
        payload: TSplitPayload | null | undefined,
        options?: {session?: IWorkspaceSplitCacheSessionState | null},
    ) => string | null;
    peek: (tabId: string, options?: {session?: IWorkspaceSplitCacheSessionState | null}) => {
        id: string;
        payload: TSplitPayload;
        session?: IWorkspaceSplitCacheSessionState;
    } | null;
    consume: (
        tabId: string,
        entryId?: string | null,
        options?: {session?: IWorkspaceSplitCacheSessionState | null},
    ) => TSplitPayload | null;
    has: (tabId: string, options?: {session?: IWorkspaceSplitCacheSessionState | null}) => boolean;
    clear: (tabId: string, entryId?: string | null) => void;
}

export interface IWorkspaceRestoreTrackerLike {
    has: (tabId: string) => boolean;
    start: (tabId: string) => void;
    finish: (tabId: string) => void;
}
