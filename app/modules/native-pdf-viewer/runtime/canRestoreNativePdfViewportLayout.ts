export interface INativePdfViewportRestoreContext {
    currentLoadGeneration: number;
    hasDocumentIdentity: boolean;
    initialVisualReady: boolean;
}

export function canRestoreNativePdfViewportLayout(
    epoch: unknown,
    context: INativePdfViewportRestoreContext,
) {
    return epoch === context.currentLoadGeneration
        && context.hasDocumentIdentity
        && context.initialVisualReady;
}
