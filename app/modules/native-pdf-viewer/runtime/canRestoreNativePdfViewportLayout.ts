interface INativePdfViewportRestoreEpoch {
    interactionEpoch: number;
    loadGeneration: number;
}

export interface INativePdfViewportRestoreContext {
    currentInteractionEpoch: number;
    currentLoadGeneration: number;
    hasDocumentIdentity: boolean;
    initialVisualReady: boolean;
    viewportReady: boolean;
}

export function createNativePdfRestoreEpoch(loadGeneration: number, interactionEpoch: number) {
    return {
        interactionEpoch,
        loadGeneration,
    } satisfies INativePdfViewportRestoreEpoch;
}

export function canRestoreNativePdfViewportLayout(
    epoch: unknown,
    context: INativePdfViewportRestoreContext,
) {
    return typeof epoch === 'object'
        && epoch !== null
        && 'loadGeneration' in epoch
        && 'interactionEpoch' in epoch
        && epoch.loadGeneration === context.currentLoadGeneration
        && epoch.interactionEpoch === context.currentInteractionEpoch
        && context.hasDocumentIdentity
        && context.initialVisualReady
        && context.viewportReady;
}
