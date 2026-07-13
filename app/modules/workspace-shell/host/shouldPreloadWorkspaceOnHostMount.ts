interface IWorkspaceHostPreloadSignals {
    hasQueuedSplitRestore: boolean;
    hasDocumentHint: boolean;
    isActive: boolean;
}

export function shouldPreloadWorkspaceOnHostMount(signals: IWorkspaceHostPreloadSignals) {
    return signals.hasQueuedSplitRestore || (signals.isActive && signals.hasDocumentHint);
}
