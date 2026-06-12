export interface IWorkspaceHostSignals {
    hasQueuedSplitRestore: boolean;
    hasDocumentHint: boolean;
    isActive: boolean;
}

export function shouldAutoRequestWorkspace(signals: IWorkspaceHostSignals) {
    return signals.hasQueuedSplitRestore || (signals.isActive && signals.hasDocumentHint);
}
