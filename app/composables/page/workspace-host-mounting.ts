import type { ITab } from '@app/types/tabs';

interface IWorkspaceHostSignals {
    hasQueuedSplitRestore: boolean;
    hasDocumentHint: boolean;
    isActive: boolean;
}

export function hasDocumentMountHint(tab: Pick<ITab, 'fileName' | 'originalPath' | 'isDjvu'>) {
    return Boolean(tab.fileName || tab.originalPath || tab.isDjvu);
}

export function shouldAutoRequestWorkspace(signals: IWorkspaceHostSignals) {
    // Mount the workspace for active tabs so global chrome (toolbar/status) remains stable,
    // and always mount when there is document state (or split restore work) to recover.
    return signals.hasQueuedSplitRestore || signals.hasDocumentHint || signals.isActive;
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
