import type {
    IAnnotationCommentSummary,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type { INativePdfMutationPlan } from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationPlanTypes';

export type TPdfViewerSaveTransactionMode =
    | 'persist'
    | 'print'
    | 'snapshot'
    | 'embedded-mutation'
    | 'pdfjs-materialize';

export type TPdfViewerSaveTransactionSource =
    | 'source-clean'
    | 'source-replay'
    | 'pdfjs-materialize'
    | 'serialized-rewrite'
    | 'native-mutation-plan';

export type TPdfViewerAnnotationSaveRoute =
    | 'source-clean'
    | 'source-replay'
    | 'pdfjs-materialize';

export type TPdfViewerAnnotationSaveReason =
    | 'pending-embedded-annotation-operations'
    | 'live-pdfjs-ids-covered-by-embedded-operations'
    | 'unreplayable-live-pdfjs-annotation-ids'
    | 'unknown-live-pdfjs-annotation-storage'
    | 'live-pdfjs-annotation-storage'
    | 'editor-only-annotations-pending-materialization'
    | 'saved-pdfjs-annotation-baseline-diverged'
    | 'live-pdfjs-annotation-baseline-diverged'
    | 'no-live-pdfjs-annotation-work';

export interface IPdfViewerAnnotationSavePlan {
    route: TPdfViewerAnnotationSaveRoute;
    expectedCost: 'small' | 'full-document';
    reason: TPdfViewerAnnotationSaveReason;
    unreplayableLiveAnnotationIds: string[];
}

export interface IPdfViewerSaveTransactionNativeCapabilities {
    hasNativePdfMutationCapability: boolean;
    canPersistNativeMetadataMutations: boolean;
}

export interface IPdfViewerSaveTransactionDocumentStructure {
    pageLabelsDirty: boolean;
    pageLabelRanges: IPdfPageLabelRange[];
    bookmarksDirty: boolean;
    bookmarkItems: IPdfBookmarkEntry[];
    untitledBookmarkLabel: string;
    totalPages: number;
}

export interface IPdfViewerSaveTransactionDirtyState {
    annotationDirty: boolean;
    hasAnnotationChanges: boolean;
    hasLivePdfJsAnnotationChanges: boolean;
    savedPdfjsAnnotationBaselineDirty: boolean;
    shapeStateDirty: boolean;
}

export interface IPdfViewerSaveTransactionSerializationOptions {
    forceRewrite?: boolean;
    includeShapes?: boolean;
    rewriteShapeState?: boolean;
    annotationCommentsSnapshot?: IAnnotationCommentSummary[];
    pendingTexts?: Map<string, string> | null;
    pendingDeletes?: IAnnotationCommentSummary[] | null;
}

export interface IPdfViewerSaveTransactionSource {
    getSourcePdfData: () => Promise<Uint8Array | null>;
    serializePdfForSave?: (
        data: Uint8Array,
        options?: IPdfViewerSaveTransactionSerializationOptions,
    ) => Promise<Uint8Array>;
}

export interface IPdfViewerSaveTransactionRequest {
    mode: TPdfViewerSaveTransactionMode;
    saveMode?: TPdfSaveMode;
    saveFlowMode?: 'save' | 'save_as';
    forceRewrite?: boolean;
    forcePdfjsMaterialize?: boolean;
    includeManagedShapes?: boolean;
    rewriteShapeState?: boolean;
    planOnly?: boolean;
    serializeResult?: boolean;
    consumePendingEmbeddedMutations?: boolean;
    annotationCommentsSnapshot?: IAnnotationCommentSummary[];
    pendingEmbeddedTextUpdates?: Map<string, string> | null;
    pendingEmbeddedAnnotationDeletes?: IAnnotationCommentSummary[] | null;
    markupSubtypeOverrides?: Map<string, TMarkupSubtype> | undefined;
    markupSubtypeHints?: IMarkupSubtypeHint[] | undefined;
    nativeCapabilities?: IPdfViewerSaveTransactionNativeCapabilities;
    dirtyState?: IPdfViewerSaveTransactionDirtyState;
    documentStructure?: IPdfViewerSaveTransactionDocumentStructure;
    source?: IPdfViewerSaveTransactionSource;
}

export interface IPdfViewerPendingEmbeddedMutationSnapshot {
    pendingEmbeddedTextUpdates: Map<string, string>;
    pendingEmbeddedAnnotationDeletes: IAnnotationCommentSummary[];
}

export interface IPdfViewerConsumedPendingEmbeddedMutations {
    pendingEmbeddedTextUpdates: Map<string, string>;
    pendingEmbeddedAnnotationDeletes: IAnnotationCommentSummary[];
    restore(): void;
    commit(): void;
}

export interface IPdfViewerSaveTransactionSerializedResult {
    finalBytes: Uint8Array;
    saveMode: TPdfSaveMode;
    source: TPdfViewerSaveTransactionSource;
}

export interface IPdfViewerSaveTransactionResult {
    source: TPdfViewerSaveTransactionSource;
    baseBytes: Uint8Array | null;
    serializedBytes: Uint8Array | null;
    serializedResult: IPdfViewerSaveTransactionSerializedResult | null;
    nativeMutationPlan: INativePdfMutationPlan | null;
    annotationSavePlan: IPdfViewerAnnotationSavePlan;
    annotationCommentsSnapshot: IAnnotationCommentSummary[];
    pendingEmbeddedTextUpdates: Map<string, string>;
    pendingEmbeddedAnnotationDeletes: IAnnotationCommentSummary[];
    restoreConsumedPendingEmbeddedMutations(): void;
    commitConsumedPendingEmbeddedMutations(): void;
}
