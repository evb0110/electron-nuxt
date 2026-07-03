import type { IPdfViewerSaveExpose } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';

export interface IPdfEmbeddedMutationBaseDataDeps {
    hasAnnotationChanges: () => boolean;
    runSaveTransaction: IPdfViewerSaveExpose['runSaveTransaction'];
    getSourcePdfData: () => Promise<Uint8Array | null>;
}

export async function getEmbeddedMutationBaseData(
    deps: IPdfEmbeddedMutationBaseDataDeps,
) {
    if (deps.hasAnnotationChanges()) {
        const result = await deps.runSaveTransaction({
            mode: 'embedded-mutation',
            forcePdfjsMaterialize: true,
        });
        return result.serializedBytes ?? result.baseBytes;
    }

    return deps.getSourcePdfData();
}
