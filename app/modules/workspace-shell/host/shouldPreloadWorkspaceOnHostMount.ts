interface IWorkspaceHostPreloadSignals {
    hasQueuedSplitRestore: boolean;
    hasDocumentHint: boolean;
    isActive: boolean;
    isDev: boolean;
}

export function shouldPreloadWorkspaceOnHostMount(signals: IWorkspaceHostPreloadSignals) {
    if (signals.hasQueuedSplitRestore || (signals.isActive && signals.hasDocumentHint)) {
        return true;
    }

    return signals.isActive && !signals.isDev;
}
