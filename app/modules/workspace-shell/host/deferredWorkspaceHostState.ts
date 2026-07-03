import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

export function workspaceHasDocumentOrOpenError(workspace: IWorkspaceExpose | null) {
    if (!workspace) {
        return false;
    }

    const snapshot = workspace.getToolbarSnapshot();
    return hasWorkspaceViewerDocumentCapabilities(snapshot.viewerCapabilities) || snapshot.hasOpenError;
}

export function workspaceHasOpenedDocument(workspace: IWorkspaceExpose | null) {
    if (!workspace) {
        return false;
    }

    const snapshot = workspace.getToolbarSnapshot();
    return hasWorkspaceViewerDocumentCapabilities(snapshot.viewerCapabilities);
}
