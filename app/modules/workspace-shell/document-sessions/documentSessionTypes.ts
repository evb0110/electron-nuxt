import type { TDocumentRef } from '@contracts/documentRef';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';

export type TWorkspaceDocumentSessionPhase =
    | 'empty'
    | 'opening'
    | 'restoring'
    | 'ready'
    | 'reloading'
    | 'closing'
    | 'error';

export type TWorkspaceDocumentTransactionKind = 'open' | 'restore' | 'reload' | 'close';

export interface IWorkspaceDocumentIdentity {
    documentSessionKey: string | null;
    documentInstanceId: TDocumentInstanceId | null;
    documentRef: TDocumentRef | null;
    originalPath: TDocumentRef | null;
    workingCopyPath: TDocumentRef | null;
    fileName: string | null;
    isDjvu: boolean;
    revisionInfo: IDocumentRevisionInfo | null;
}

export interface IWorkspaceDocumentTransaction {
    id: string;
    tabId: string;
    kind: TWorkspaceDocumentTransactionKind;
    documentRef: TDocumentRef | null;
    startedAt: number;
    persist?: boolean | undefined;
}

export interface IWorkspacePendingCloseDecision {
    persist: boolean;
    target: TWorkspaceCommandTarget;
}

export interface IWorkspaceDocumentSessionSnapshot {
    tabId: string;
    sessionId: string;
    sessionRevision: number;
    phase: TWorkspaceDocumentSessionPhase;
    identity: IWorkspaceDocumentIdentity;
    activeTransaction: IWorkspaceDocumentTransaction | null;
    mounted: boolean;
    toolbarSnapshot: IWorkspaceToolbarSnapshot;
    viewState: ITabViewSessionState;
    dirty: boolean;
    closeable: boolean;
    pendingDocumentPath: TDocumentRef | null;
    pendingClose: IWorkspacePendingCloseDecision | null;
}

export interface IWorkspaceDocumentSessionController {
    readonly tabId: string;
    readonly snapshot: Readonly<Ref<IWorkspaceDocumentSessionSnapshot>>;
    readonly mountedWorkspace: ShallowRef<IWorkspaceExpose | null>;

    beginTransaction(input: Omit<IWorkspaceDocumentTransaction, 'id' | 'tabId' | 'startedAt'>): IWorkspaceDocumentTransaction;
    finishTransaction(id: string, result: 'committed' | 'cancelled' | 'failed'): void;
    applyWorkspaceRecord(record: IWorkspaceDocumentRecord, source: 'host' | 'workspace'): void;
    applyRevisionInfo(info: IDocumentRevisionInfo | null): void;
    applyViewState(state: ITabViewSessionState): void;
    attachWorkspace(workspace: IWorkspaceExpose): void;
    detachWorkspace(workspace?: IWorkspaceExpose): void;
    waitForWorkspace(target: TWorkspaceCommandTarget, timeoutMs?: number): Promise<IWorkspaceExpose | null>;
    createCommandTarget(mode?: 'current' | 'active-transaction'): TWorkspaceCommandTarget;
    validateCommandTarget(target: TWorkspaceCommandTarget): {ok: true} | {
        ok: false;
        reason: string
    };
    toDocumentRecord(): IWorkspaceDocumentRecord;
}
