import {
    expect,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
} from '@app/types/annotations';
import type { IFileOperationsSaveAdapterPorts } from '@app/modules/workspace-shell/composables/file-operations/saveRolePorts';
import { useFileOperationsSaveController as useFileOperationsSaveControllerPublic } from '@app/modules/workspace-shell/composables/file-operations/useFileOperationsSaveController';
import { usePdfViewerSaveTransaction } from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import { cast } from '@tests/helpers/cast';

export const toastAddMock = vi.fn();
type TFileOperationsSaveControllerTestDeps =
    IFileOperationsSaveAdapterPorts['state']['status']
    & IFileOperationsSaveAdapterPorts['state']['documentIdentity']
    & IFileOperationsSaveAdapterPorts['state']['annotations']
    & IFileOperationsSaveAdapterPorts['state']['metadata']
    & IFileOperationsSaveAdapterPorts['state']['metadataCompletion']
    & IFileOperationsSaveAdapterPorts['pdf']['source']
    & IFileOperationsSaveAdapterPorts['pdf']['serialization']
    & IFileOperationsSaveAdapterPorts['persistence']['file']
    & NonNullable<IFileOperationsSaveAdapterPorts['persistence']['nativeWorkingCopy']>
    & NonNullable<IFileOperationsSaveAdapterPorts['persistence']['nativeMutations']>
    & IFileOperationsSaveAdapterPorts['annotationEdits']
    & IFileOperationsSaveAdapterPorts['viewer']['markup']
    & IFileOperationsSaveAdapterPorts['viewer']['shapes']
    & IFileOperationsSaveAdapterPorts['viewer']['shapeState']
    & IFileOperationsSaveAdapterPorts['lifecycle']
    & NonNullable<IFileOperationsSaveAdapterPorts['operationLease']>;
export type TPdfNativeMutationSave = NonNullable<NonNullable<
    IFileOperationsSaveAdapterPorts['persistence']['nativeMutations']
>['trySavePdfNativeMutations']>;

vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

export function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return {
        promise,
        resolve,
        reject,
    };
}

function createSaveControllerPorts(
    deps: TFileOperationsSaveControllerTestDeps,
): IFileOperationsSaveAdapterPorts {
    return {
        state: {
            status: deps,
            documentIdentity: deps,
            annotations: deps,
            metadata: deps,
            metadataCompletion: deps,
        },
        pdf: {
            source: deps,
            serialization: deps,
        },
        persistence: {
            file: deps,
            nativeWorkingCopy: deps,
            nativeMutations: deps,
        },
        annotationEdits: deps,
        viewer: {
            markup: deps,
            shapes: deps,
            shapeState: deps,
        },
        lifecycle: deps,
        operationLease: deps,
    };
}

export function useFileOperationsSaveController(deps: TFileOperationsSaveControllerTestDeps) {
    return useFileOperationsSaveControllerPublic(createSaveControllerPorts(deps));
}

export function createDeps(overrides: Partial<Parameters<typeof useFileOperationsSaveController>[0]> = {}) {
    const resetModified = vi.fn();
    const saveFile = vi.fn(async (_data: Uint8Array) => ({
        success: true,
        outPath: '/tmp/work.pdf',
        saveMode: 'rewrite' as const,
        didSaveAs: false,
    }));
    const saveWorkingCopyAs = vi.fn(async (
        _data?: Uint8Array,
        _opts?: Parameters<IFileOperationsSaveAdapterPorts['persistence']['file']['saveWorkingCopyAs']>[1],
    ) => ({
        success: true,
        outPath: '/tmp/new.pdf',
        saveMode: 'save_as_rewrite' as const,
        didSaveAs: true,
    }));

    const deps = cast<Parameters<typeof useFileOperationsSaveController>[0]>({
        isSaving: ref(false),
        isSavingAs: ref(false),
        originalPath: ref('/tmp/source.pdf'),
        workingCopyPath: ref('/tmp/work.pdf'),
        documentRevisionToken: ref('rev-1'),
        annotationDirty: ref(false),
        annotationComments: ref([]),
        pageLabelsDirty: ref(false),
        bookmarksDirty: ref(false),
        pdfDocument: shallowRef(cast({ annotationStorage: { resetModified } })),
        saveDocument: vi.fn(async () => new Uint8Array([1])),
        getSourcePdfData: vi.fn(async () => new Uint8Array([1])),
        validatePdfPath: vi.fn(async () => ({
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        })),
        saveFile,
        saveWorkingCopy: vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        })),
        saveWorkingCopyAs,
        markAnnotationSaved: vi.fn(),
        markPageLabelsSaved: vi.fn(),
        markBookmarksSaved: vi.fn(),
        hasAnnotationChanges: vi.fn(() => false),
        hasShapeChanges: vi.fn(() => false),
        serializePdfForSave: vi.fn(async (data: Uint8Array) => new Uint8Array([
            ...data,
            2,
            3,
            6,
            4,
            5,
        ])),
        persistAllAnnotationNotes: vi.fn(async (_force: boolean) => true),
        consumePendingEmbeddedTextUpdates: vi.fn(() => null),
        restorePendingEmbeddedTextUpdates: vi.fn(),
        consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
        restorePendingEmbeddedAnnotationDeletes: vi.fn(),
        annotationNoteWindowsCount: ref(0),
        loadRecentFiles: vi.fn(),
        markShapeStateSaved: vi.fn(),
        preparePersistedShapeStateForSave: vi.fn(async () => null),
        restorePreparedPersistedShapeState: vi.fn(async () => undefined),
        adoptPersistedShapeStateForNextReload: vi.fn(),
        clearPendingPersistedShapeStateForNextReload: vi.fn(),
        ...overrides,
    });
    if (!overrides.runSaveTransaction) {
        const transaction = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse: deps.saveDocument,
            ...(deps.commitPdfEditorsForSave ? {commitPdfEditorsForSave: deps.commitPdfEditorsForSave} : {}),
            getPdfDocument: () => deps.pdfDocument.value,
            getAnnotationCommentsSnapshot: () => deps.getAnnotationCommentsSnapshot?.() ?? deps.annotationComments.value,
            getMarkupSubtypeOverrides: () => deps.getMarkupSubtypeOverrides?.(),
            getMarkupSubtypeHints: () => deps.getMarkupSubtypeHints?.(),
            getAllShapes: () => deps.getAllShapes?.() ?? [],
            getDeletedEmbeddedShapeAnnotationIds: () => deps.getDeletedEmbeddedShapeAnnotationIds?.() ?? [],
            getDeletedEmbeddedShapeStableKeys: () => deps.getDeletedEmbeddedShapeStableKeys?.() ?? [],
        });
        deps.runSaveTransaction = vi.fn(request => transaction.runSaveTransaction(request));
    }

    return {
        deps,
        resetModified,
        saveFile,
        saveWorkingCopyAs,
    };
}

export function expectWorkspaceSaveMarked(deps: ReturnType<typeof createDeps>['deps']) {
    expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
    expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
    expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
    expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
}

export function expectWorkspaceSaveNotMarked(deps: ReturnType<typeof createDeps>['deps']) {
    expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
    expect(deps.markPageLabelsSaved).not.toHaveBeenCalled();
    expect(deps.markBookmarksSaved).not.toHaveBeenCalled();
    expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
}

export function createPdfNoteComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? '3856R',
        stableKey: overrides.stableKey ?? 'ann:0:3856R',
        sortIndex: null,
        pageIndex: 0,
        pageNumber: 1,
        text: overrides.text ?? 'Original note',
        kindLabel: 'Note',
        subtype: overrides.subtype ?? 'Text',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: overrides.annotationId ?? '3856R',
        source: overrides.source ?? 'pdf',
        hasNote: overrides.hasNote ?? true,
        markerRect: null,
        ...overrides,
    };
}

export function createMarkupComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? '44R',
        stableKey: overrides.stableKey ?? 'ann:0:44R',
        sortIndex: null,
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        kindLabel: 'Highlight',
        subtype: overrides.subtype ?? 'Highlight',
        author: null,
        modifiedAt: null,
        color: overrides.color ?? '#22c55e',
        colorEdited: overrides.colorEdited ?? true,
        uid: null,
        annotationId: overrides.annotationId ?? '44R',
        source: overrides.source ?? 'pdf',
        hasNote: false,
        markerRect: overrides.markerRect ?? {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.2,
        },
        ...overrides,
    };
}

export function createEditorFreeTextNote(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? 'pdfjs_internal_editor_0',
        stableKey: overrides.stableKey ?? 'uid:0:pdfjs_internal_editor_0',
        sortIndex: null,
        pageIndex: 0,
        pageNumber: 1,
        text: overrides.text ?? 'Editor note',
        kindLabel: 'Inline Note',
        subtype: overrides.subtype ?? 'Typewriter',
        author: overrides.author ?? 'Tester',
        modifiedAt: null,
        createdAt: overrides.createdAt ?? 1781009077000,
        color: overrides.color ?? 'rgba(255, 204, 0, 0.8)',
        uid: overrides.uid ?? 'pdfjs_internal_editor_0',
        annotationId: overrides.annotationId ?? null,
        source: overrides.source ?? 'editor',
        hasNote: overrides.hasNote ?? true,
        markerRect: overrides.markerRect ?? {
            left: 0.1,
            top: 0.2,
            width: 0.0016,
            height: 0.0016,
        },
        ...overrides,
    };
}

export function createShapeAnnotation(overrides: Partial<IShapeAnnotation> = {}): IShapeAnnotation {
    return {
        id: overrides.id ?? 'shape-1',
        type: overrides.type ?? 'rectangle',
        pageIndex: overrides.pageIndex ?? 0,
        x: overrides.x ?? 0.1,
        y: overrides.y ?? 0.2,
        width: overrides.width ?? 0.3,
        height: overrides.height ?? 0.2,
        color: overrides.color ?? '#336699',
        fillColor: overrides.fillColor ?? '#abcdef',
        opacity: overrides.opacity ?? 0.5,
        strokeWidth: overrides.strokeWidth ?? 3,
        source: overrides.source ?? 'local',
        stableKey: overrides.stableKey ?? 'evb-shape:shape-1',
        createdAt: overrides.createdAt ?? 1781009077000,
        modifiedAt: overrides.modifiedAt ?? 1781009087000,
        ...overrides,
    };
}
