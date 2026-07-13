interface IWorkspaceHostPlaceholderSignals {
    hasQueuedSplitRestore: boolean;
    hasPendingDocumentHint: boolean;
    hasVisibleDocument: boolean;
    isDocumentOpenInFlight: boolean;
}

export function shouldShowWorkspacePlaceholder(signals: IWorkspaceHostPlaceholderSignals) {
    return (
        !signals.hasQueuedSplitRestore
        && !signals.hasVisibleDocument
    );
}
