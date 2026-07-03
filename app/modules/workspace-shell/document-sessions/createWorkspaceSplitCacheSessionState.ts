import type { IWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/composables/workspaceSplitTypes';
import type { IWorkspaceDocumentSessionController } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';

export function createWorkspaceSplitCacheSessionState(
    session: IWorkspaceDocumentSessionController | null | undefined,
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
        ...(snapshot.identity.revisionInfo?.token === undefined
            ? {}
            : {documentRevisionToken: snapshot.identity.revisionInfo.token}),
    };
}
