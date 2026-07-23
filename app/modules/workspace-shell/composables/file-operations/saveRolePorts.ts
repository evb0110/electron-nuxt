import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {
    PDFDocumentProxy,
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type {
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfPersistResult,
    IPdfSaveResult,
    IScrollSnapshot,
} from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNoteTextUpdate,
    IPdfOptimizeOptions,
    IPdfSerializedCommitCallbacks,
} from '@contracts/electronApiDocuments';
import type {
    IMarkupSubtypeHint,
    IPdfViewerAnnotationCommentExpose,
    IPdfViewerSaveExpose,
    IPdfViewerShapeExpose,
} from '@app/modules/pdf-viewer/public';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import type {
    IWorkspaceDocumentViewerNavigationPort,
    IWorkspacePdfViewerAnnotationChangesPort,
    IWorkspacePdfViewerSplitPort,
} from '@app/modules/workspace-shell/types/workspaceOrchestration.types';

export interface IWorkspaceSaveStatusPort {
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
}

export interface IWorkspaceSaveDocumentIdentityPort {
    workingCopyPath: Ref<TDocumentRef | null>;
    originalPath: Ref<TDocumentRef | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
}

export interface IWorkspaceSaveAnnotationStatePort {
    annotationDirty: Ref<boolean>;
    markAnnotationSaved: (opts?: { preserveLivePdfjsSession?: boolean }) => void;
    getAnnotationSaveStateToken?: () => unknown;
    hasAnnotationChanges: () => boolean;
    hasLivePdfJsAnnotationChanges?: () => boolean;
    hasSavedPdfJsAnnotationBaselineChanges?: () => boolean;
    hasPreservedAnnotationSourceChanges?: () => boolean;
    hasPendingAnnotationDeletes?: () => boolean;
}

export interface IWorkspaceSaveMetadataStatePort {
    totalPages?: Ref<number>;
    pageLabelsDirty: Ref<boolean>;
    pageLabelRanges?: Ref<IPdfPageLabelRange[]>;
    bookmarksDirty: Ref<boolean>;
    bookmarkItems?: Ref<IPdfBookmarkEntry[]>;
    untitledBookmarkLabel?: string;
}

export interface IWorkspaceSaveMetadataCompletionPort {
    markPageLabelsSaved: () => void;
    getPageLabelsSaveStateToken?: () => unknown;
    markBookmarksSaved: () => void;
    getBookmarksSaveStateToken?: () => unknown;
}

export interface IWorkspaceSavePdfSourcePort {
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    runSaveTransaction: IPdfViewerSaveExpose['runSaveTransaction'];
    saveDocument: () => Promise<Uint8Array | null>;
    getSourcePdfData: () => Promise<Uint8Array | null>;
    commitPdfEditorsForSave?: () => Promise<void>;
}

export interface IWorkspaceSavePdfSerializationPort {serializePdfForSave: (
    data: Uint8Array,
    options?: {
        forceRewrite?: boolean;
        includeShapes?: boolean;
        rewriteShapeState?: boolean;
    },
) => Promise<Uint8Array>;}

export interface IWorkspaceSavePersistOptions {
    saveMode?: TPdfSaveMode;
    expectedWorkingPath?: TDocumentRef | null;
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    changedObjectRefs?: string[];
}

export interface IWorkspaceSavePersistSerializedOptions extends IWorkspaceSavePersistOptions {
    preserveLoadedSource?: boolean;
    commitCallbacks?: IPdfSerializedCommitCallbacks;
}

export interface IWorkspaceSavePersistAsOptions extends IWorkspaceSavePersistOptions {
    optimizeLossless?: boolean;
    commitCallbacks?: IPdfSerializedCommitCallbacks;
}

export interface IWorkspaceSavePersistencePort {
    validatePdfPath: (path: TDocumentRef) => Promise<IPdfSaveResult['validation']>;
    saveFile: (
        data: Uint8Array,
        opts?: IWorkspaceSavePersistSerializedOptions,
    ) => Promise<IPdfPersistResult>;
    saveWorkingCopy: (opts?: IWorkspaceSavePersistOptions) => Promise<IPdfPersistResult>;
    saveWorkingCopyAs: (
        data?: Uint8Array,
        opts?: IWorkspaceSavePersistAsOptions,
    ) => Promise<IPdfPersistResult>;
}

export interface IWorkspaceSaveNativeWorkingCopyPersistencePort {
    repairWorkingCopy?: (opts?: IWorkspaceSavePersistOptions) => Promise<IPdfPersistResult>;
    optimizeWorkingCopy?: (opts?: IWorkspaceSavePersistOptions) => Promise<IPdfPersistResult>;
    optimizeWorkingCopyAsCopy?: (
        options: IPdfOptimizeOptions,
        requestId?: string,
        opts?: IWorkspaceSavePersistOptions,
    ) => Promise<IPdfPersistResult>;
    optimizePdfOnSaveAs?: Ref<boolean>;
    getWorkingCopySize?: (path: TDocumentRef) => Promise<number | null>;
}

export interface IWorkspaceSaveNativeMutationOptions extends IWorkspaceSavePersistSerializedOptions {
    saveMode: TPdfSaveMode;
    modifiedAt: string;
    verifyPathBeforeExpose?: (path: TDocumentRef, knownSize: number) => Promise<void>;
    assertBeforeExpose?: () => Promise<void> | void;
}

export interface IWorkspaceSaveEmbeddedNoteTextUpdateOptions extends IWorkspaceSaveNativeMutationOptions {
    freeTextNotes?: IPdfNativeFreeTextNote[];
    deletes?: IPdfNativeAnnotationDelete[];
}

export interface IWorkspaceSaveNativeMutationPersistencePort {
    trySaveEmbeddedNoteTextUpdates?: (
        updates: IPdfNoteTextUpdate[],
        opts: IWorkspaceSaveEmbeddedNoteTextUpdateOptions,
    ) => Promise<IPdfPersistResult | null>;
    trySavePdfNativeMutations?: (
        mutations: IPdfNativeMutationSet,
        opts: IWorkspaceSaveNativeMutationOptions,
    ) => Promise<IPdfPersistResult | null>;
}

export interface IWorkspaceSaveMarkupSourcePort {
    getMarkupSubtypeOverrides?: () => Map<string, TMarkupSubtype> | undefined;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[] | undefined;
}

export interface IWorkspaceSaveShapeQueryPort {
    hasShapeChanges?: () => boolean;
    hasManagedShapes?: () => boolean;
    getAllShapes?: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds?: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
}

export interface IWorkspaceSaveShapeStatePort {
    markShapeStateSaved?: () => void;
    preparePersistedShapeStateForSave?: (data: Uint8Array) => Promise<unknown>;
    restorePreparedPersistedShapeState?: (snapshot: unknown) => Promise<void> | void;
    adoptPersistedShapeStateForNextReload?: () => void;
    clearPendingPersistedShapeStateForNextReload?: () => void;
}

export interface IWorkspaceSaveEmbeddedAnnotationEditsPort {
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    clearAnnotationHistory?: () => void;
    annotationNoteWindowsCount: Ref<number>;
}

export interface IWorkspaceSaveLifecyclePort {
    loadRecentFiles: () => void;
    preparePostSaveReload?: () => {
        promise: Promise<void>;
        cancel: () => void;
    };
}

export interface IWorkspaceSaveOperationLeasePort {runWithDocumentOperationLease?: <T>(
    kind: TDocumentOperationKind,
    operation: () => Promise<T>,
) => Promise<T>;}

export interface IFileOperationsSaveStatePorts {
    status: IWorkspaceSaveStatusPort;
    documentIdentity: IWorkspaceSaveDocumentIdentityPort;
    annotations: IWorkspaceSaveAnnotationStatePort;
    metadata: IWorkspaceSaveMetadataStatePort;
    metadataCompletion: IWorkspaceSaveMetadataCompletionPort;
}

export interface IFileOperationsSavePdfPorts {
    source: IWorkspaceSavePdfSourcePort;
    serialization: IWorkspaceSavePdfSerializationPort;
}

export interface IFileOperationsSavePersistencePorts {
    file: IWorkspaceSavePersistencePort;
    nativeWorkingCopy?: IWorkspaceSaveNativeWorkingCopyPersistencePort;
    nativeMutations?: IWorkspaceSaveNativeMutationPersistencePort;
}

export interface IFileOperationsSaveViewerPorts {
    markup: IWorkspaceSaveMarkupSourcePort;
    shapes: IWorkspaceSaveShapeQueryPort;
    shapeState: IWorkspaceSaveShapeStatePort;
}

export interface IFileOperationsSaveAdapterPorts {
    state: IFileOperationsSaveStatePorts;
    pdf: IFileOperationsSavePdfPorts;
    persistence: IFileOperationsSavePersistencePorts;
    annotationEdits: IWorkspaceSaveEmbeddedAnnotationEditsPort;
    viewer: IFileOperationsSaveViewerPorts;
    lifecycle: IWorkspaceSaveLifecyclePort;
    operationLease?: IWorkspaceSaveOperationLeasePort;
}

export type IWorkspacePdfViewerSaveDocumentPort = IWorkspacePdfViewerSplitPort;

export interface IWorkspacePdfViewerSaveReloadPort extends Pick<IWorkspaceDocumentViewerNavigationPort, 'scrollToPage'> {
    captureScrollSnapshot?: () => IScrollSnapshot | null;
    restoreScrollSnapshot?: (
        snapshot: IScrollSnapshot | null,
        options?: { fallbackPage?: number | null; },
    ) => void;
    preserveNextSourceReloadVisibleContent?: (request?: {
        scrollSnapshot?: IScrollSnapshot | null;
        pageToRestore?: number | null;
    }) => void;
}

export interface IWorkspacePdfViewerSaveAnnotationSourcePort extends
    Pick<IWorkspacePdfViewerAnnotationChangesPort,
        'getAllShapes'
        | 'hasShapes'
    >,
    Pick<IPdfViewerAnnotationCommentExpose,
        'getMarkupSubtypeHints'
        | 'getMarkupSubtypeOverrides'
    >,
    Pick<IPdfViewerShapeExpose,
        'getDeletedEmbeddedShapeAnnotationIds'
        | 'getDeletedEmbeddedShapeStableKeys'
        | 'markSavedShapeState'
    > {}

export interface IWorkspacePdfViewerSaveShapeStatePort {
    adoptPersistedManagedShapesOnNextImport?: () => void;
    clearPendingManagedShapeImportAdoption?: () => void;
    ensureManagedShapeBaselineReady?: () => Promise<void>;
    preparePersistedManagedShapesForSave?: (data: Uint8Array) => Promise<unknown>;
    restorePreparedManagedShapesAfterFailedSave?: (snapshot: unknown) => Promise<void>;
}

export type TWorkspacePdfViewerSavePort =
    IWorkspacePdfViewerSaveDocumentPort
    & IWorkspacePdfViewerSaveReloadPort
    & IWorkspacePdfViewerSaveAnnotationSourcePort
    & IWorkspacePdfViewerSaveShapeStatePort;
