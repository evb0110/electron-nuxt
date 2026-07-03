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
    pendingTexts?: Map<string, string> | null | undefined;
    pendingDeletes?: IAnnotationCommentSummary[] | null | undefined;
    consumePendingEmbeddedTextUpdates?: () => Map<string, string> | null;
    restorePendingEmbeddedTextUpdates?: (updates: Map<string, string> | null | undefined) => void;
    consumePendingEmbeddedAnnotationDeletes?: () => IAnnotationCommentSummary[] | null;
    restorePendingEmbeddedAnnotationDeletes?: (deletions: IAnnotationCommentSummary[] | null | undefined) => void;
}

export async function serializePrintableSourceData(
    rawData: Uint8Array,
    deps: ISerializePrintableSourceDataDeps,
) {
    if (
        deps.pendingTexts !== undefined
        || deps.pendingDeletes !== undefined
    ) {
        return deps.serializePdfForSave(rawData, {
            includeShapes: true,
            rewriteShapeState: true,
            pendingTexts: deps.pendingTexts ?? null,
            pendingDeletes: deps.pendingDeletes ?? null,
        });
    }

    const pendingTexts = deps.consumePendingEmbeddedTextUpdates?.() ?? null;
    const pendingDeletes = deps.consumePendingEmbeddedAnnotationDeletes?.() ?? null;

    try {
        return await deps.serializePdfForSave(rawData, {
            includeShapes: true,
            rewriteShapeState: true,
            pendingTexts,
            pendingDeletes,
        });
    } finally {
        deps.restorePendingEmbeddedTextUpdates?.(pendingTexts);
        deps.restorePendingEmbeddedAnnotationDeletes?.(pendingDeletes);
    }
}
