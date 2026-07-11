import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';

/** Save flow supported by the native mutation projection. */
export type TNativePdfMutationSaveMode = 'save' | 'save_as';

export interface INativePdfMutationAnnotationSavePlan {
    route: string;
    reason: string;
}

export interface INativePdfMutationProjectionCommonInput {
    mode: TNativePdfMutationSaveMode;
    pendingTexts: Map<string, string> | null;
    pendingDeletes: IAnnotationCommentSummary[] | null;
    shapeStateDirty: boolean;
    forcePdfjsMaterialize: boolean;
    includeManagedShapesForLiveSource: boolean;
    forceRewrite: boolean;
    pageLabelsDirty: boolean;
    bookmarksDirty: boolean;
    hasNativePdfMutationCapability: boolean;
    annotationSavePlan: INativePdfMutationAnnotationSavePlan;
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

export interface INativePdfMutationProjection {
    canonicalAnnotationProgram: readonly IBackendAnnotationMutation[];
    mutations: IPdfNativeMutationSet;
    noteTextUpdates: IPdfNoteTextUpdate[];
    freeTextNotes: IPdfNativeFreeTextNote[];
    annotationDeletes: IPdfNativeAnnotationDelete[];
    hasMetadataMutations: boolean;
    hasShapeMutations: boolean;
    hasMarkupMutations: boolean;
    phase: string;
}

export interface INativePdfMutationProjectionResult {
    projection: INativePdfMutationProjection | null;
    skipEvents: INativePdfMutationSkipEvent[];
}

export interface INativePdfMutationProjectionInput extends INativePdfMutationProjectionCommonInput {
    canonicalAnnotationProgram: readonly IBackendAnnotationMutation[];
    canonicalComments: IAnnotationCommentSummary[];
    savedPdfjsAnnotationBaselineDirty: boolean;
    annotationDirty: boolean;
    hasAnnotationChanges: boolean;
    hasLivePdfJsAnnotationChanges: boolean;
    canPersistNativeMetadataMutations: boolean;
    totalPageCount: number;
    pageLabelRanges: IPdfPageLabelRange[] | null;
    bookmarkItems: IPdfBookmarkEntry[] | null;
    untitledBookmarkLabel: string;
    shapes: IShapeAnnotation[] | null;
    deletedEmbeddedShapeAnnotationIds: string[];
    deletedEmbeddedShapeStableKeys: string[];
    markupSubtypeOverrides: Map<string, TMarkupSubtype> | undefined;
    markupSubtypeHints: IMarkupSubtypeHint[];
}
