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
    // Keep empty tabs on the lightweight placeholder so the prerendered shell
    // paints quickly. Real workspaces still mount eagerly when there is document
    // state or split-restore work to recover.
    return signals.hasQueuedSplitRestore || signals.hasDocumentHint;
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
