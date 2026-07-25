import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

interface IWorkspaceHostPlaceholderSignals {
    hasQueuedSplitRestore: boolean;
    hasPendingDocumentHint: boolean;
    hasVisibleDocument: boolean;
    isDocumentOpenInFlight: boolean;
}

export function shouldShowWorkspacePlaceholder(signals: IWorkspaceHostPlaceholderSignals) {
    return (
        !signals.hasQueuedSplitRestore
        && !signals.hasPendingDocumentHint
        && !signals.hasVisibleDocument
        && !signals.isDocumentOpenInFlight
    );
}

export function shouldKeepWorkspacePendingDocumentHint(signals: {
    hasDocumentHint: boolean;
    isClosingDocument: boolean;
    mountedSnapshot: IWorkspaceToolbarSnapshot | null;
}) {
    return signals.hasDocumentHint
        && !signals.isClosingDocument
        && signals.mountedSnapshot?.hasOpenError !== true
        && !(
            signals.mountedSnapshot?.initialVisualReady
            && hasWorkspaceViewerDocumentCapabilities(signals.mountedSnapshot.viewerCapabilities)
        );
}
