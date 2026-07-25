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
import type {ISerializationPlan} from '@app/modules/pdf-viewer/serialization/serializationPlan';
import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import type {IPdfLiveAnnotationChangeSummary} from '@app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges';

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
    | 'native-mutation-projection';

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

export interface IPdfSaveCanonicalInputs {
    readonly comments: IAnnotationCommentSummary[];
    readonly pendingTexts: Map<string, string>;
    readonly pendingDeletes: IAnnotationCommentSummary[];
    readonly liveAnnotationChanges: IPdfLiveAnnotationChangeSummary;
    readonly replayableEmbeddedAnnotationIds: ReadonlySet<string>;
}

export type TNativeSaveRouteRejection =
    | 'backend-not-native-append'
    | 'save-descriptors-unavailable'
    | 'not-save-mode'
    | 'native-save-capability-unavailable'
    | 'managed-shapes-require-materialization'
    | 'saved-pdfjs-baseline-dirty-requires-materialization'
    | 'pdfjs-materialize-required'
    | 'pending-texts-not-covered-by-native-mutations'
    | 'pending-deletes-not-covered-by-native-mutations'
    | 'live-pdfjs-annotation-work-not-covered-by-native-mutations'
    | 'annotation-work-not-covered-by-native-mutations'
    | 'shape-payload-unavailable'
    | 'metadata-payload-unavailable'
    | 'native-structured-save-capability-unavailable'
    | 'native-write-failed'
    | 'no-native-mutations-projected';

export interface IPdfSaveByteRouteDecision {
    readonly route: TPdfViewerAnnotationSaveRoute;
    readonly annotationPlan: IPdfViewerAnnotationSavePlan;
    readonly canonical: IPdfSaveCanonicalInputs;
    readonly baseBytes: 'loaded-source' | 'pdfjs-materialize';
    /** Precondition: source bytes may only replace a failed materialization on the source-replay route. */
    readonly sourceFallbackAllowed: boolean;
    readonly nativeRejection: TNativeSaveRouteRejection;
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

export interface IPdfViewerSaveTransactionSerializationOptions {
    annotationSerializationPlan?: ISerializationPlan;
    forceRewrite?: boolean;
    includeShapes?: boolean;
    rewriteShapeState?: boolean;
}

export interface IPdfViewerSaveTransactionSource {
    getSourcePdfData: () => Promise<Uint8Array | null>;
    serializePdfForSave?: (
        data: Uint8Array,
        options?: IPdfViewerSaveTransactionSerializationOptions,
    ) => Promise<Uint8Array>;
}

export interface IPdfViewerSaveTransactionRequest {
    annotationSerializationPlan?: ISerializationPlan;
    mode: TPdfViewerSaveTransactionMode;
    saveMode?: TPdfSaveMode;
    saveFlowMode?: 'save' | 'save_as';
    forceRewrite?: boolean;
    forcePdfjsMaterialize?: boolean;
    includeManagedShapes?: boolean;
    rewriteShapeState?: boolean;
    planOnly?: boolean;
    serializeResult?: boolean;
    markupSubtypeOverrides?: Map<string, TMarkupSubtype> | undefined;
    markupSubtypeHints?: IMarkupSubtypeHint[] | undefined;
    nativeCapabilities?: IPdfViewerSaveTransactionNativeCapabilities;
    dirtyState?: IPdfViewerSaveTransactionDirtyState;
    documentStructure?: IPdfViewerSaveTransactionDocumentStructure;
    source?: IPdfViewerSaveTransactionSource;
}

export interface IPdfViewerSaveTransactionSerializedResult {
    finalBytes: Uint8Array;
    saveMode: TPdfSaveMode;
    source: TPdfViewerSaveTransactionSource;
    changedObjectRefs: readonly string[];
}

export interface IPdfViewerSaveTransactionResult {
    source: TPdfViewerSaveTransactionSource;
    baseBytes: Uint8Array | null;
    serializedBytes: Uint8Array | null;
    serializedResult: IPdfViewerSaveTransactionSerializedResult | null;
    nativeMutationProjection: INativePdfMutationProjection | null;
    /** Exact classifier-owned alternate; consumers must not independently plan another route. */
    fallbackDecision: IPdfSaveByteRouteDecision;
    annotationSavePlan: IPdfViewerAnnotationSavePlan;
    verifyAnnotationSave?(bytes: Uint8Array): Promise<void>;
    verifyAnnotationSavePath?(path: string, knownSize: number): Promise<void>;
    assertAnnotationSaveCurrent?(): Promise<void> | void;
    commitAnnotationSave?(): void;
    /**
     * Executes the exact classifier-owned fallback captured by a plan-only
     * transaction. It retains the same annotation frontier and serialization
     * plan; callers must never start another transaction after native decline.
     */
    executeFallback?(): Promise<IPdfViewerSaveTransactionResult>;
}

export function resolvePdfViewerSaveTransactionFinalBytes(
    result: IPdfViewerSaveTransactionResult | null | undefined,
) {
    return result?.serializedResult?.finalBytes
        ?? result?.serializedBytes
        ?? result?.baseBytes
        ?? null;
}
