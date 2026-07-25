import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';
import type {
    INativePdfMutationProjection,
    IPdfViewerSaveTransactionDirtyState,
    IPdfViewerSaveTransactionDocumentStructure,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
export type {INativePdfMutationProjection} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';

/** Save flow supported by the native mutation projection. */
export type TNativePdfMutationSaveMode = 'save' | 'save_as';

export interface INativePdfMutationAnnotationSavePlan {
    route: string;
    reason: string;
}

/**
 * The native-append grant emitted once by `classifyPdfSaveRoute`. Native projectors
 * assert it and read its flags; they never re-derive a mode, capability, or route.
 */
export interface INativeAppendSaveRoute {
    readonly route: 'native-append';
    /** Only `source-replay` admits replayable annotation mutations onto this route. */
    readonly annotationRoute: INativePdfMutationAnnotationSavePlan;
    readonly replayableAnnotationMutationsAllowed: boolean;
    readonly metadataMutationsAllowed: boolean;
    readonly annotationWorkDirty: boolean;
    readonly pdfjsMaterializeForced: boolean;
}

export interface INativePdfMutationSkipEvent {
    event: string;
    reason: string;
    details: Record<string, unknown>;
}

export interface INativePdfMutationBuildResult<T> {
    value: T | null;
    skipEvents: INativePdfMutationSkipEvent[];
}

export interface INativePdfMutationProjectionResult {
    projection: INativePdfMutationProjection | null;
    skipEvents: INativePdfMutationSkipEvent[];
}

export interface INativePdfMutationProjectionInput {
    route: INativeAppendSaveRoute;
    dirtyState: IPdfViewerSaveTransactionDirtyState;
    documentStructure: IPdfViewerSaveTransactionDocumentStructure;
    canonicalAnnotationProgram: readonly IBackendAnnotationMutation[];
    canonicalComments: IAnnotationCommentSummary[];
    pendingTexts: Map<string, string>;
    pendingDeletes: IAnnotationCommentSummary[];
    totalPageCount: number;
    shapes: IShapeAnnotation[] | null;
    deletedEmbeddedShapeAnnotationIds: string[];
    deletedEmbeddedShapeStableKeys: string[];
    markupSubtypeOverrides: Map<string, TMarkupSubtype> | undefined;
    markupSubtypeHints: IMarkupSubtypeHint[];
}
