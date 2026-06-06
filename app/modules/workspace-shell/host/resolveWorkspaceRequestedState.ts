import { shouldAutoRequestWorkspace } from '@app/modules/workspace-shell/host/shouldAutoRequestWorkspace';

interface IWorkspaceHostSignals {
    hasQueuedSplitRestore: boolean;
    hasDocumentHint: boolean;
    isActive: boolean;
}

export function resolveWorkspaceRequestedState(
    currentRequested: boolean,
    signals: IWorkspaceHostSignals,
) {
    if (currentRequested) {
        return true;
    }

    return shouldAutoRequestWorkspace(signals);
}
