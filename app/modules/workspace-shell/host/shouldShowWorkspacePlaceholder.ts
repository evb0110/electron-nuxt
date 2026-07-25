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
    hasMountedOpenError: boolean;
    hasMountedSuccessfulVisual: boolean;
}) {
    return signals.hasDocumentHint
        && !signals.hasMountedOpenError
        && !signals.hasMountedSuccessfulVisual;
}
