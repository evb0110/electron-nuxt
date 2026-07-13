export function shouldKeepWorkspaceDocumentLayoutVisible(options: {
    hasDocument: boolean;
    keepDocumentLayoutMounted: boolean;
}) {
    return options.hasDocument || options.keepDocumentLayoutMounted;
}
