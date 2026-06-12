import type { TSplitPayload } from '@contracts/windowTabs';

export interface IWorkspaceSplitCacheLike {
    set: (tabId: string, payload: TSplitPayload | null | undefined) => string | null;
    peek: (tabId: string) => {
        id: string;
        payload: TSplitPayload;
    } | null;
    consume: (tabId: string, entryId?: string | null) => TSplitPayload | null;
    has: (tabId: string) => boolean;
    clear: (tabId: string, entryId?: string | null) => void;
}

export interface IWorkspaceRestoreTrackerLike {
    has: (tabId: string) => boolean;
    start: (tabId: string) => void;
    finish: (tabId: string) => void;
}
