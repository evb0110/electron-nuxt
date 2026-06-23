import type { IAnnotationCommentSummary } from '@app/types/annotations';

interface ISerializePrintableSourceDataOptions {
    includeShapes?: boolean;
    rewriteShapeState?: boolean;
    pendingTexts?: Map<string, string> | null;
    pendingDeletes?: IAnnotationCommentSummary[] | null;
}

interface ISerializePrintableSourceDataDeps {
    serializePdfForSave: (
        data: Uint8Array,
        options?: ISerializePrintableSourceDataOptions,
    ) => Promise<Uint8Array>;
    consumePendingEmbeddedTextUpdates: () => Map<string, string> | null;
    restorePendingEmbeddedTextUpdates: (updates: Map<string, string> | null | undefined) => void;
    consumePendingEmbeddedAnnotationDeletes: () => IAnnotationCommentSummary[] | null;
    restorePendingEmbeddedAnnotationDeletes: (deletions: IAnnotationCommentSummary[] | null | undefined) => void;
}

export async function serializePrintableSourceData(
    rawData: Uint8Array,
    deps: ISerializePrintableSourceDataDeps,
) {
    const pendingTexts = deps.consumePendingEmbeddedTextUpdates();
    const pendingDeletes = deps.consumePendingEmbeddedAnnotationDeletes();

    try {
        return await deps.serializePdfForSave(rawData, {
            includeShapes: true,
            rewriteShapeState: true,
            pendingTexts,
            pendingDeletes,
        });
    } finally {
        deps.restorePendingEmbeddedTextUpdates(pendingTexts);
        deps.restorePendingEmbeddedAnnotationDeletes(pendingDeletes);
    }
}
