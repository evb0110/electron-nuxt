import type { IWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/composables/workspaceSplitTypes';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';

export function createWorkspaceSplitCacheSessionState(
    session: IWorkspaceDocumentController | null | undefined,
): IWorkspaceSplitCacheSessionState | null {
    const snapshot = session?.snapshot.value;
    if (!snapshot) {
        return null;
    }

    const documentBackend = resolveDocumentRefBackend(snapshot.identity.documentRef);
    return {
        sessionId: snapshot.sessionId,
        sessionRevision: snapshot.sessionRevision,
        documentRef: snapshot.identity.documentRef,
        ...(documentBackend === undefined ? {} : {documentBackend}),
        documentInstanceId: snapshot.identity.documentInstanceId,
        ...(snapshot.identity.revisionInfo?.token === undefined
            ? {}
            : {documentRevisionToken: snapshot.identity.revisionInfo.token}),
    };
}
