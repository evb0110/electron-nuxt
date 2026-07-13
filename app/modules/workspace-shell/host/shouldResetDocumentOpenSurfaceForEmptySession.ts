import type { IWorkspaceDocumentSessionSnapshot } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import type { IDocumentOpenSurfaceSnapshot } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

export function shouldResetDocumentOpenSurfaceForEmptySession(
    session: IWorkspaceDocumentSessionSnapshot,
    surface: IDocumentOpenSurfaceSnapshot,
) {
    return session.phase === 'empty'
        && session.identity.documentSessionKey === null
        && session.identity.documentInstanceId === null
        && session.activeTransaction === null
        && surface.phase !== 'idle';
}
