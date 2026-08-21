import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';

export type TWorkspaceDocumentPhase =
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
export interface IWorkspaceDocumentSnapshot {
    tabId: string;
    sessionId: string;
    sessionRevision: number;
    phase: TWorkspaceDocumentPhase;
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
