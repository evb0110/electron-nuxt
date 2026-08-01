export interface INativePdfViewportRestoreContext {
    currentLoadGeneration: number;
    hasDocumentIdentity: boolean;
}

export function canRestoreNativePdfViewportLayout(
    epoch: unknown,
    context: INativePdfViewportRestoreContext,
) {
    return epoch === context.currentLoadGeneration && context.hasDocumentIdentity;
}
