import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IWorkspaceDocumentSessionSnapshot } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

export interface IWorkspaceRestoreAttemptState {
    completedRestoreKeys: Set<string>;
    inFlightRestoreKeys: Set<string>;
}

export function createWorkspaceRestoreAttemptState(): IWorkspaceRestoreAttemptState {
    return {
        completedRestoreKeys: new Set(),
        inFlightRestoreKeys: new Set(),
    };
}

export function workspaceSessionHasOpenedDocument(snapshot: IWorkspaceDocumentSessionSnapshot | null | undefined) {
    if (
        !snapshot
        || snapshot.phase === 'closing'
        || snapshot.phase === 'error'
    ) {
        return false;
    }

    return hasWorkspaceViewerDocumentCapabilities(snapshot.toolbarSnapshot.viewerCapabilities)
        || snapshot.identity.documentRef !== null
        || snapshot.identity.originalPath !== null
        || snapshot.identity.fileName !== null
        || snapshot.identity.isDjvu;
}

function createWorkspaceRestoreAttemptKey(
    snapshot: IWorkspaceDocumentSessionSnapshot,
    path: TDocumentRef,
) {
    return `${snapshot.sessionId}\u0000${path}`;
}

export function tryClaimWorkspaceRestoreAttempt(
    state: IWorkspaceRestoreAttemptState,
    snapshot: IWorkspaceDocumentSessionSnapshot,
    path: TDocumentRef,
) {
    const key = createWorkspaceRestoreAttemptKey(snapshot, path);
    if (state.completedRestoreKeys.has(key) || state.inFlightRestoreKeys.has(key)) {
        return false;
    }

    state.inFlightRestoreKeys.add(key);
    return true;
}

export function finishWorkspaceRestoreAttempt(
    state: IWorkspaceRestoreAttemptState,
    snapshot: IWorkspaceDocumentSessionSnapshot,
    path: TDocumentRef,
    completed: boolean,
) {
    const key = createWorkspaceRestoreAttemptKey(snapshot, path);
    state.inFlightRestoreKeys.delete(key);
    if (completed) {
        state.completedRestoreKeys.add(key);
    }
}

export function workspaceHasDocumentOrOpenError(
    workspace: IWorkspaceExpose | null,
    snapshot?: IWorkspaceDocumentSessionSnapshot | null,
) {
    if (!workspace) {
        return snapshot?.toolbarSnapshot.hasOpenError === true;
    }

    const toolbarSnapshot = workspace.getToolbarSnapshot();
    return hasWorkspaceViewerDocumentCapabilities(toolbarSnapshot.viewerCapabilities) || toolbarSnapshot.hasOpenError;
}

export function workspaceHasOpenedDocument(
    workspace: IWorkspaceExpose | null,
    snapshot?: IWorkspaceDocumentSessionSnapshot | null,
) {
    if (!workspace) {
        return workspaceSessionHasOpenedDocument(snapshot);
    }

    const toolbarSnapshot = workspace.getToolbarSnapshot();
    return hasWorkspaceViewerDocumentCapabilities(toolbarSnapshot.viewerCapabilities);
}
