export interface IPdfEmbeddedMutationBaseDataDeps {
    hasAnnotationChanges: () => boolean;
    saveDocument: () => Promise<Uint8Array | null>;
    getSourcePdfData: () => Promise<Uint8Array | null>;
}

export async function getEmbeddedMutationBaseData(
    deps: IPdfEmbeddedMutationBaseDataDeps,
) {
    if (deps.hasAnnotationChanges()) {
        return deps.saveDocument();
    }

    return deps.getSourcePdfData();
}
