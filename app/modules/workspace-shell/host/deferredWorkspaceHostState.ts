import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IWorkspaceDocumentSessionSnapshot } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

export interface IWorkspaceRestoreAttemptState {attemptedRestoreKeys: Set<string>;}

export function createWorkspaceRestoreAttemptState(): IWorkspaceRestoreAttemptState {
    return { attemptedRestoreKeys: new Set() };
}

export function workspaceSessionHasOpenedDocument(snapshot: IWorkspaceDocumentSessionSnapshot | null | undefined) {
    if (!snapshot || snapshot.phase !== 'ready') {
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
    if (state.attemptedRestoreKeys.has(key)) {
        return false;
    }

    state.attemptedRestoreKeys.add(key);
    return true;
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
