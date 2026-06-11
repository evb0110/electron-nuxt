import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import type { IMarkupSubtypeHint } from '@app/utils/pdf-viewer/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';

export type TNativePdfMutationSaveMode = 'save' | 'save_as';

export interface INativePdfMutationAnnotationSavePlan {
    route: string;
    reason: string;
}

export interface INativePdfMutationPlanCommonInput {
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

export interface INativePdfMutationPlan {
    mutations: IPdfNativeMutationSet;
    noteTextUpdates: IPdfNoteTextUpdate[];
    freeTextNotes: IPdfNativeFreeTextNote[];
    annotationDeletes: IPdfNativeAnnotationDelete[];
    hasMetadataMutations: boolean;
    hasShapeMutations: boolean;
    hasMarkupMutations: boolean;
    phase: string;
}

export interface INativePdfMutationPlanBuildResult {
    plan: INativePdfMutationPlan | null;
    skipEvents: INativePdfMutationSkipEvent[];
}

export interface INativePdfMutationPlanInput extends INativePdfMutationPlanCommonInput {
    annotationCommentsSnapshot: IAnnotationCommentSummary[];
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
