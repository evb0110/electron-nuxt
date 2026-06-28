import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
} from '@app/types/annotations';
import type { IFileOperationsSaveAdapterPorts } from '@app/modules/workspace-shell/composables/file-operations/saveRolePorts';
import { PDF_SAVE_TIMEOUT_MS } from '@app/constants/timeouts';
import { useFileOperationsSaveController as useFileOperationsSaveControllerPublic } from '@app/modules/workspace-shell/composables/file-operations/useFileOperationsSaveController';
import { cast } from '@tests/helpers/cast';

const toastAddMock = vi.fn();
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
type TPdfNativeMutationSave = NonNullable<NonNullable<
    IFileOperationsSaveAdapterPorts['persistence']['nativeMutations']
>['trySavePdfNativeMutations']>;

vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

function createDeferred<T>() {
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

function useFileOperationsSaveController(deps: TFileOperationsSaveControllerTestDeps) {
    return useFileOperationsSaveControllerPublic(createSaveControllerPorts(deps));
}

function createDeps(overrides: Partial<Parameters<typeof useFileOperationsSaveController>[0]> = {}) {
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

    return {
        deps: cast<Parameters<typeof useFileOperationsSaveController>[0]>({
            isSaving: ref(false),
            isSavingAs: ref(false),
            originalPath: ref('/tmp/source.pdf'),
            workingCopyPath: ref('/tmp/work.pdf'),
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
        }),
        resetModified,
        saveFile,
        saveWorkingCopyAs,
    };
}

function expectWorkspaceSaveMarked(deps: ReturnType<typeof createDeps>['deps']) {
    expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
    expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
    expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
    expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
}

function expectWorkspaceSaveNotMarked(deps: ReturnType<typeof createDeps>['deps']) {
    expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
    expect(deps.markPageLabelsSaved).not.toHaveBeenCalled();
    expect(deps.markBookmarksSaved).not.toHaveBeenCalled();
    expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
}

function createPdfNoteComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
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

function createMarkupComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
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

function createEditorFreeTextNote(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
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

function createShapeAnnotation(overrides: Partial<IShapeAnnotation> = {}): IShapeAnnotation {
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

describe('useFileOperationsSaveController', () => {
    beforeEach(() => {
        toastAddMock.mockClear();
    });

    it('serializes and saves when working copy has pending annotation-related changes', async () => {
        const {
            deps,
            resetModified,
            saveFile,
        } = createDeps({annotationDirty: ref(true)});
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(saveFile).toHaveBeenCalledOnce();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            1,
            2,
            3,
            6,
            4,
            5,
        ]);
        expect(resetModified).toHaveBeenCalledOnce();
        expectWorkspaceSaveMarked(deps);
        expect(deps.isSaving.value).toBe(false);
        expect(deps.validatePdfPath).not.toHaveBeenCalled();
    });

    it('saves working copy directly when no serialization work is required', async () => {
        const { deps } = createDeps();
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.validatePdfPath).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
        expectWorkspaceSaveMarked(deps);
        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
    });

    it('skips clean working-copy save when validation resolves after the working copy changed', async () => {
        const validation = createDeferred<{
            isValid: boolean;
            tool: 'qpdf';
            errors: string[];
            warnings: string[];
        }>();
        const validatePdfPath = vi.fn(() => validation.promise);
        const { deps } = createDeps({validatePdfPath});
        const { handleSave } = useFileOperationsSaveController(deps);

        const savePromise = handleSave();

        await vi.waitFor(() => {
            expect(validatePdfPath).toHaveBeenCalledWith('/tmp/work.pdf');
        });
        deps.workingCopyPath.value = '/tmp/other-work.pdf';
        validation.resolve({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });

        await expect(savePromise).resolves.toBe(false);
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expectWorkspaceSaveNotMarked(deps);
        expect(deps.isSaving.value).toBe(false);
    });

    it('restores pending embedded text updates when the original save target changes before persistence', async () => {
        const notePersistence = createDeferred<boolean>();
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const { deps } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            annotationNoteWindowsCount: ref(1),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            persistAllAnnotationNotes: vi.fn(() => notePersistence.promise),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const savePromise = handleSave();
        await Promise.resolve();

        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledWith(true);
        deps.originalPath.value = '/tmp/different-source.pdf';
        notePersistence.resolve(true);

        await expect(savePromise).resolves.toBe(false);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.restorePendingEmbeddedTextUpdates).toHaveBeenCalledWith(pendingTexts);
        expectWorkspaceSaveNotMarked(deps);
        expect(deps.isSaving.value).toBe(false);
    });

    it('skips serialized persistence when the original target changes after source bytes are prepared', async () => {
        const sourceBytes = createDeferred<Uint8Array>();
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const { deps } = createDeps({
            annotationDirty: ref(true),
            hasPreservedAnnotationSourceChanges: vi.fn(() => true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            saveDocument: vi.fn(() => sourceBytes.promise),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const savePromise = handleSave();

        await vi.waitFor(() => {
            expect(deps.saveDocument).toHaveBeenCalledOnce();
        });
        deps.originalPath.value = '/tmp/different-source.pdf';
        sourceBytes.resolve(new Uint8Array([1]));

        await expect(savePromise).resolves.toBe(false);
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.restorePendingEmbeddedTextUpdates).toHaveBeenCalledWith(pendingTexts);
        expectWorkspaceSaveNotMarked(deps);
        expect(deps.isSaving.value).toBe(false);
    });

    it('skips serialized persistence when the working copy target changes after source bytes are prepared', async () => {
        const sourceBytes = createDeferred<Uint8Array | null>();
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const { deps } = createDeps({
            annotationDirty: ref(true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            getSourcePdfData: vi.fn(() => sourceBytes.promise),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const savePromise = handleSave();

        await vi.waitFor(() => {
            expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        });
        deps.workingCopyPath.value = '/tmp/other-work.pdf';
        sourceBytes.resolve(new Uint8Array([1]));

        await expect(savePromise).resolves.toBe(false);
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.restorePendingEmbeddedTextUpdates).toHaveBeenCalledWith(pendingTexts);
        expectWorkspaceSaveNotMarked(deps);
        expect(deps.isSaving.value).toBe(false);
    });

    it('cancels post-save reload when stale target protection skips serialized persistence', async () => {
        const sourceBytes = createDeferred<Uint8Array | null>();
        const deferredReload = createDeferred<undefined>();
        const cancel = vi.fn();
        const { deps } = createDeps({
            pageLabelsDirty: ref(true),
            getSourcePdfData: vi.fn(() => sourceBytes.promise),
            preparePostSaveReload: () => ({
                promise: deferredReload.promise,
                cancel,
            }),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const savePromise = handleSave();

        await vi.waitFor(() => {
            expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        });
        deps.workingCopyPath.value = '/tmp/other-work.pdf';
        sourceBytes.resolve(new Uint8Array([1]));

        await expect(savePromise).resolves.toBe(false);
        expect(cancel).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.clearPendingPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
        expectWorkspaceSaveNotMarked(deps);
        expect(deps.isSaving.value).toBe(false);
    });

    it('skips native mutation persistence when the working copy target changes before the native write', async () => {
        const notePersistence = createDeferred<boolean>();
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const { deps } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            annotationNoteWindowsCount: ref(1),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            persistAllAnnotationNotes: vi.fn(() => notePersistence.promise),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const savePromise = handleSave();
        await Promise.resolve();

        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledWith(true);
        deps.workingCopyPath.value = '/tmp/other-work.pdf';
        notePersistence.resolve(true);

        await expect(savePromise).resolves.toBe(false);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.restorePendingEmbeddedTextUpdates).toHaveBeenCalledWith(pendingTexts);
        expectWorkspaceSaveNotMarked(deps);
        expect(deps.isSaving.value).toBe(false);
    });

    it('waits for the document operation lease before saving the working copy', async () => {
        const leaseRelease = createDeferred<undefined>();
        const runWithDocumentOperationLease = vi.fn(async (_kind: 'save', operation: () => Promise<boolean>) => {
            await leaseRelease.promise;
            return operation();
        });
        const { deps } = createDeps({ runWithDocumentOperationLease: cast(runWithDocumentOperationLease) });
        const { handleSave } = useFileOperationsSaveController(deps);

        const savePromise = handleSave();
        await Promise.resolve();

        expect(runWithDocumentOperationLease).toHaveBeenCalledWith('save', expect.any(Function));
        expect(deps.isSaving.value).toBe(true);
        expect(deps.validatePdfPath).not.toHaveBeenCalled();

        leaseRelease.resolve(undefined);
        await expect(savePromise).resolves.toBe(true);

        expect(deps.validatePdfPath).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
        expect(deps.isSaving.value).toBe(false);
    });

    it('serializes when the saved PDF.js annotation baseline is dirty', async () => {
        const {
            deps,
            saveFile,
        } = createDeps({
            hasSavedPdfJsAnnotationBaselineChanges: vi.fn(() => true),
            saveDocument: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.validatePdfPath).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledWith(
            new Uint8Array([9]),
            expect.objectContaining({ forceRewrite: false }),
        );
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('repair-saves by forcing a serialized rewrite when native repair is unavailable', async () => {
        const {
            deps,
            saveFile,
        } = createDeps();
        const { handleRepairSave } = useFileOperationsSaveController(deps);

        await handleRepairSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.validatePdfPath).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledWith(
            new Uint8Array([1]),
            expect.objectContaining({forceRewrite: true}),
        );
        expect(saveFile).toHaveBeenCalledOnce();
        expectWorkspaceSaveMarked(deps);
    });

    it('commits active PDF.js editors before collecting save state and choosing the save route', async () => {
        const annotationStorage = {
            resetModified: vi.fn(),
            serializable: {
                map: new Map(),
                hash: '',
                transfer: [],
            },
            modifiedIds: { ids: new Set() },
        };
        const commitPdfEditorsForSave = vi.fn(async () => {
            annotationStorage.serializable = {
                map: new Map([[
                    'active-editor',
                    { value: 'typed text' },
                ]]),
                hash: 'typed-text',
                transfer: [],
            };
        });
        const consumePendingEmbeddedTextUpdates = vi.fn(() => null);
        const {
            deps,
            saveFile,
        } = createDeps({
            pageLabelsDirty: ref(true),
            pdfDocument: shallowRef(cast({ annotationStorage })),
            saveDocument: vi.fn(async () => new Uint8Array([7])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
            commitPdfEditorsForSave,
            consumePendingEmbeddedTextUpdates,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(commitPdfEditorsForSave).toHaveBeenCalledOnce();
        expect(consumePendingEmbeddedTextUpdates).toHaveBeenCalledOnce();
        expect(commitPdfEditorsForSave.mock.invocationCallOrder[0]!)
            .toBeLessThan(consumePendingEmbeddedTextUpdates.mock.invocationCallOrder[0]!);
        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            7,
            2,
            3,
            6,
            4,
            5,
        ]);
    });

    it('does not mark newer annotation, page-label, or bookmark edits clean after an older snapshot saves', async () => {
        let annotationToken = 'annotation-before';
        let pageLabelsToken = 'labels-before';
        let bookmarksToken = 'bookmarks-before';
        const saveFile = vi.fn(async () => {
            annotationToken = 'annotation-after';
            pageLabelsToken = 'labels-after';
            bookmarksToken = 'bookmarks-after';
            return {
                success: true,
                outPath: '/tmp/work.pdf',
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const {
            deps,
            resetModified,
        } = createDeps({
            annotationDirty: ref(true),
            pageLabelsDirty: ref(true),
            bookmarksDirty: ref(true),
            saveFile,
            getAnnotationSaveStateToken: () => annotationToken,
            getPageLabelsSaveStateToken: () => pageLabelsToken,
            getBookmarksSaveStateToken: () => bookmarksToken,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await expect(handleSave()).resolves.toBe(true);

        expect(saveFile).toHaveBeenCalledOnce();
        expect(resetModified).not.toHaveBeenCalled();
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
        expect(deps.markPageLabelsSaved).not.toHaveBeenCalled();
        expect(deps.markBookmarksSaved).not.toHaveBeenCalled();
    });

    it('refreshes the annotation baseline after a live serialized save materializes PDF.js storage', async () => {
        let annotationToken = 'annotation-before';
        const saveDocument = vi.fn(async () => {
            annotationToken = 'annotation-after-materialize';
            return new Uint8Array([9]);
        });
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            getAnnotationSaveStateToken: () => annotationToken,
            hasAnnotationChanges: vi.fn(() => true),
            saveDocument,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await expect(handleSave()).resolves.toBe(true);

        expect(saveFile).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).toHaveBeenCalledWith({ preserveLivePdfjsSession: true });
    });

    it('keeps newer live annotation edits dirty when they happen during serialized persistence', async () => {
        let annotationToken = 'annotation-before';
        const saveFile = vi.fn(async () => {
            annotationToken = 'annotation-after-newer-edit';
            return {
                success: true,
                outPath: '/tmp/work.pdf',
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const { deps } = createDeps({
            annotationDirty: ref(true),
            getAnnotationSaveStateToken: () => annotationToken,
            hasAnnotationChanges: vi.fn(() => true),
            saveDocument: vi.fn(async () => {
                annotationToken = 'annotation-after-materialize';
                return new Uint8Array([9]);
            }),
            saveFile,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await expect(handleSave()).resolves.toBe(true);

        expect(saveFile).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
    });

    it('repair-saves clean documents through the native working-copy repair path when available', async () => {
        const repairWorkingCopy = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({repairWorkingCopy});
        const { handleRepairSave } = useFileOperationsSaveController(deps);

        await handleRepairSave();

        expect(repairWorkingCopy).toHaveBeenCalledWith({
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/work.pdf',
        });
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.validatePdfPath).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expectWorkspaceSaveMarked(deps);
    });

    it('optimizes clean documents through the native working-copy optimize path when available', async () => {
        const optimizeWorkingCopy = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({optimizeWorkingCopy});
        const { handleOptimizePdfForInteraction } = useFileOperationsSaveController(deps);

        await handleOptimizePdfForInteraction();

        expect(optimizeWorkingCopy).toHaveBeenCalledWith({
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/work.pdf',
        });
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.validatePdfPath).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expectWorkspaceSaveMarked(deps);
    });

    it('blocks large unsupported serialized saves before reading or materializing full PDF bytes', async () => {
        const getWorkingCopySize = vi.fn(async () => 512 * 1024 * 1024 + 1);
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            getWorkingCopySize,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await expect(handleSave()).resolves.toBe(false);

        expect(getWorkingCopySize).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: expect.stringContaining('Large PDF save requires a native save path'),
        }));
    });

    it('preserves annotation undo history after a successful save', async () => {
        const clearAnnotationHistory = vi.fn();
        const { deps } = createDeps({
            annotationDirty: ref(true),
            clearAnnotationHistory,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(clearAnnotationHistory).not.toHaveBeenCalled();
    });

    it('saves clean Save As from the working copy without serialization', async () => {
        const {
            deps,
            saveWorkingCopyAs,
        } = createDeps();
        const { handleSaveAs } = useFileOperationsSaveController(deps);

        await handleSaveAs();

        expect(deps.validatePdfPath).toHaveBeenCalledOnce();
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveWorkingCopyAs).toHaveBeenCalledWith(undefined, {
            saveMode: 'save_as_rewrite',
            expectedWorkingPath: '/tmp/work.pdf',
            optimizeLossless: false,
        });
        expectWorkspaceSaveMarked(deps);
    });

    it('serializes on save-as and refreshes recent files when path is returned', async () => {
        const {
            deps,
            resetModified,
            saveWorkingCopyAs,
        } = createDeps({annotationDirty: ref(true)});
        const { handleSaveAs } = useFileOperationsSaveController(deps);

        await handleSaveAs();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveWorkingCopyAs).toHaveBeenCalledOnce();
        expect(Array.from(saveWorkingCopyAs.mock.calls[0]?.[0] ?? [])).toEqual([
            1,
            2,
            3,
            6,
            4,
            5,
        ]);
        expect(resetModified).toHaveBeenCalledOnce();
        expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
        expect(deps.isSavingAs.value).toBe(false);
        expect(deps.validatePdfPath).not.toHaveBeenCalled();
    });

    it('passes the PDF optimization setting to serialized Save As persistence', async () => {
        const {
            deps,
            saveWorkingCopyAs,
        } = createDeps({
            annotationDirty: ref(true),
            optimizePdfOnSaveAs: ref(true),
        });
        const { handleSaveAs } = useFileOperationsSaveController(deps);

        await handleSaveAs();

        expect(saveWorkingCopyAs).toHaveBeenCalledOnce();
        expect(saveWorkingCopyAs.mock.calls[0]?.[1]).toMatchObject({
            saveMode: 'save_as_rewrite',
            expectedWorkingPath: '/tmp/work.pdf',
            optimizeLossless: true,
        });
    });

    it('aborts save early when note windows cannot be persisted', async () => {
        const { deps } = createDeps({
            annotationNoteWindowsCount: ref(2),
            persistAllAnnotationNotes: vi.fn(async () => false),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledWith(true);
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.isSaving.value).toBe(false);
    });

    it('aborts save when validation fails', async () => {
        const validatePdfPath = vi.fn(async () => ({
            isValid: false,
            tool: 'qpdf' as const,
            errors: ['broken pdf'],
            warnings: [],
        }));
        const { deps } = createDeps({ validatePdfPath });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
        expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
    });

    it('uses PDF.js saveDocument when live annotation storage has modified ids', async () => {
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['3856R']) },
        } }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            pdfDocument: livePdfDocument,
            saveDocument: vi.fn(async () => new Uint8Array([7])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            7,
            2,
            3,
            6,
            4,
            5,
        ]);
    });

    it('uses source bytes when PDF.js serializable editor id maps back to a pending existing annotation ref', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['3856R']) },
            serializable: {
                map: new Map([[
                    'pdfjs_internal_editor_0',
                    { id: '3856R' },
                ]]),
                hash: 'existing-note-hash',
                transfer: [],
            },
        } }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            pdfDocument: livePdfDocument,
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            saveDocument: vi.fn(async () => new Uint8Array([7])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledWith(
            new Uint8Array([9]),
            expect.objectContaining({ pendingTexts }),
        );
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            9,
            2,
            3,
            6,
            4,
            5,
        ]);
    });

    it('uses the native note text save path for direct PDF-sourced note updates', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).toHaveBeenCalledWith(
            [{
                objectNumber: 3856,
                generationNumber: 0,
                text: 'Updated note',
            }],
            expect.objectContaining({
                saveMode: 'rewrite',
                expectedWorkingPath: '/tmp/work.pdf',
                preserveLoadedSource: true,
                modifiedAt: expect.stringMatching(/^D:\d{14}[+-]\d{2}'\d{2}'$/u),
            }),
        );
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
    });

    it('serializes PDF-backed FreeText note text updates through the full serializer', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment({
                subtype: 'FreeText',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.0016,
                    height: 0.0016,
                },
            })]),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledWith(
            new Uint8Array([9]),
            expect.objectContaining({pendingTexts}),
        );
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('uses the native PDF mutation path for page labels and bookmarks', async () => {
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(3),
            pageLabelsDirty: ref(true),
            pageLabelRanges: ref([{
                startPage: 1,
                style: 'r',
                prefix: 'intro-',
                startNumber: 2,
            }]),
            bookmarksDirty: ref(true),
            bookmarkItems: ref([{
                title: 'Chapter 1',
                pageIndex: 0,
                namedDest: null,
                bold: true,
                italic: false,
                color: '#336699',
                items: [],
            }]),
            untitledBookmarkLabel: 'Untitled',
            trySavePdfNativeMutations,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).toHaveBeenCalledWith(
            {
                pageLabels: {
                    totalPages: 3,
                    ranges: [{
                        startPage: 1,
                        style: 'r',
                        prefix: 'intro-',
                        startNumber: 2,
                    }],
                },
                bookmarks: {
                    totalPages: 3,
                    untitledLabel: 'Untitled',
                    items: [expect.objectContaining({
                        title: 'Chapter 1',
                        pageIndex: 0,
                    })],
                },
            },
            expect.objectContaining({
                saveMode: 'rewrite',
                expectedWorkingPath: '/tmp/work.pdf',
                preserveLoadedSource: true,
                modifiedAt: expect.stringMatching(/^D:\d{14}[+-]\d{2}'\d{2}'$/u),
            }),
        );
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
    });

    it('refreshes page-label and bookmark baselines when a native metadata save changes tokens', async () => {
        let pageLabelsToken = 'labels-before';
        let bookmarksToken = 'bookmarks-before';
        const trySavePdfNativeMutations = vi.fn(async () => {
            pageLabelsToken = 'labels-after';
            bookmarksToken = 'bookmarks-after';
            return {
                success: true,
                outPath: '/tmp/work.pdf',
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(3),
            pageLabelsDirty: ref(true),
            pageLabelRanges: ref([{
                startPage: 1,
                style: 'D',
                prefix: '',
                startNumber: 1,
            }]),
            bookmarksDirty: ref(true),
            bookmarkItems: ref([{
                title: 'Chapter 1',
                pageIndex: 0,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }]),
            trySavePdfNativeMutations,
            getPageLabelsSaveStateToken: () => pageLabelsToken,
            getBookmarksSaveStateToken: () => bookmarksToken,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
    });

    it('uses the native PDF mutation path for text-markup rewrites', async () => {
        const trySavePdfNativeMutations = vi.fn<TPdfNativeMutationSave>(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createMarkupComment({
                subtype: 'Squiggly',
                color: '#22c55e',
                colorEdited: true,
            })]),
            getMarkupSubtypeOverrides: vi.fn(() => new Map([[
                '44R',
                'Squiggly' as const,
            ]])),
            getMarkupSubtypeHints: vi.fn(() => []),
            hasLivePdfJsAnnotationChanges: vi.fn(() => false),
            hasPreservedAnnotationSourceChanges: vi.fn(() => true),
            trySavePdfNativeMutations,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(trySavePdfNativeMutations.mock.calls[0]?.[0].markup).toMatchObject({
            overrides: [[
                '44R',
                'Squiggly',
            ]],
            hints: [expect.objectContaining({
                subtype: 'Squiggly',
                annotationId: '44R',
                color: '#22c55e',
            })],
        });
        expect(trySavePdfNativeMutations.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/work.pdf',
            preserveLoadedSource: true,
            modifiedAt: expect.stringMatching(/^D:\d{14}[+-]\d{2}'\d{2}'$/u),
        }));
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
    });

    it('refreshes the annotation baseline when a native markup save changes the storage token', async () => {
        let annotationToken = 'annotation-before';
        const trySavePdfNativeMutations = vi.fn<TPdfNativeMutationSave>(async () => {
            annotationToken = 'annotation-after-native-save';
            return {
                success: true,
                outPath: '/tmp/work.pdf',
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const { deps } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createMarkupComment({
                subtype: 'Highlight',
                colorEdited: true,
            })]),
            getAnnotationSaveStateToken: () => annotationToken,
            getMarkupSubtypeOverrides: vi.fn(() => new Map([[
                '44R',
                'Highlight' as const,
            ]])),
            getMarkupSubtypeHints: vi.fn(() => []),
            hasLivePdfJsAnnotationChanges: vi.fn(() => false),
            hasPreservedAnnotationSourceChanges: vi.fn(() => true),
            trySavePdfNativeMutations,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).toHaveBeenCalledWith({ preserveLivePdfjsSession: true });
    });

    it('falls back to serialized save when native markup hints are stale', async () => {
        const trySavePdfNativeMutations = vi.fn<TPdfNativeMutationSave>(async () => {
            throw new Error('stale markup should not reach native persistence');
        });
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([]),
            getMarkupSubtypeOverrides: vi.fn(() => new Map([[
                '44R',
                'Squiggly' as const,
            ]])),
            getMarkupSubtypeHints: vi.fn(() => [{
                subtype: 'Squiggly' as const,
                pageIndex: 0,
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.3,
                    height: 0.2,
                },
                consumed: false,
                annotationId: '44R',
                color: '#22c55e',
                id: '44R',
                pageMarkupIndex: null,
                source: 'pdf' as const,
            }]),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
            hasLivePdfJsAnnotationChanges: vi.fn(() => false),
            hasPreservedAnnotationSourceChanges: vi.fn(() => true),
            trySavePdfNativeMutations,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).not.toHaveBeenCalled();
        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('uses native note updates when preserved source dirtiness is fully replayable', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const trySavePdfNativeMutations = vi.fn<TPdfNativeMutationSave>(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            hasPreservedAnnotationSourceChanges: vi.fn(() => true),
            trySavePdfNativeMutations,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).toHaveBeenCalledWith(
            {updates: [{
                objectNumber: 3856,
                generationNumber: 0,
                text: 'Updated note',
            }]},
            expect.objectContaining({
                saveMode: 'rewrite',
                expectedWorkingPath: '/tmp/work.pdf',
                preserveLoadedSource: true,
                modifiedAt: expect.stringMatching(/^D:\d{14}[+-]\d{2}'\d{2}'$/u),
            }),
        );
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
    });

    it('materializes through PDF.js when a preserved live markup baseline changed without native note work', async () => {
        const trySavePdfNativeMutations = vi.fn<TPdfNativeMutationSave>(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createMarkupComment()]),
            getMarkupSubtypeHints: vi.fn(() => [{
                subtype: 'Highlight' as const,
                pageIndex: 0,
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.3,
                    height: 0.2,
                },
                consumed: false,
                annotationId: '44R',
                color: '#22c55e',
                id: '44R',
                pageMarkupIndex: null,
                source: 'pdf' as const,
            }]),
            hasSavedPdfJsAnnotationBaselineChanges: vi.fn(() => true),
            trySavePdfNativeMutations,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).not.toHaveBeenCalled();
        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('combines note updates and metadata in one native PDF mutation save', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            totalPages: ref(2),
            pageLabelsDirty: ref(true),
            pageLabelRanges: ref([{
                startPage: 1,
                style: 'D',
                prefix: 'p.',
                startNumber: 1,
            }]),
            trySavePdfNativeMutations,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).toHaveBeenCalledWith(
            expect.objectContaining({
                updates: [{
                    objectNumber: 3856,
                    generationNumber: 0,
                    text: 'Updated note',
                }],
                pageLabels: {
                    totalPages: 2,
                    ranges: [{
                        startPage: 1,
                        style: 'D',
                        prefix: 'p.',
                        startNumber: 1,
                    }],
                },
            }),
            expect.any(Object),
        );
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
    });

    it('uses the native PDF mutation path for dirty managed shapes', async () => {
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const savedBytes = new Uint8Array([
            7,
            8,
            9,
        ]);
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(2),
            hasShapeChanges: vi.fn(() => true),
            getAllShapes: vi.fn(() => [createShapeAnnotation()]),
            getDeletedEmbeddedShapeAnnotationIds: vi.fn(() => ['44R']),
            getDeletedEmbeddedShapeStableKeys: vi.fn(() => ['evb-shape:deleted']),
            trySavePdfNativeMutations,
            getSourcePdfData: vi.fn(async () => savedBytes),
            preparePersistedShapeStateForSave: vi.fn(async () => ({snapshot: true})),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).toHaveBeenCalledWith(
            {shapes: {
                totalPages: 2,
                rewriteShapeState: true,
                shapes: [expect.objectContaining({
                    id: 'shape-1',
                    type: 'rectangle',
                    pageIndex: 0,
                    stableKey: 'evb-shape:shape-1',
                    color: '#336699',
                    fillColor: '#abcdef',
                })],
                deletedAnnotationIds: ['44R'],
                deletedStableKeys: ['evb-shape:deleted'],
            }},
            expect.objectContaining({
                saveMode: 'rewrite',
                expectedWorkingPath: '/tmp/work.pdf',
                preserveLoadedSource: true,
            }),
        );
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.preparePersistedShapeStateForSave).toHaveBeenCalledWith(savedBytes);
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
    });

    it('combines native note updates and dirty managed shapes in one mutation save', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const { deps } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            totalPages: ref(1),
            hasShapeChanges: vi.fn(() => true),
            getAllShapes: vi.fn(() => [createShapeAnnotation()]),
            trySavePdfNativeMutations,
            getSourcePdfData: vi.fn(async () => new Uint8Array([7])),
            preparePersistedShapeStateForSave: vi.fn(async () => ({snapshot: true})),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(trySavePdfNativeMutations).toHaveBeenCalledWith(
            expect.objectContaining({
                updates: [{
                    objectNumber: 3856,
                    generationNumber: 0,
                    text: 'Updated note',
                }],
                shapes: expect.objectContaining({
                    totalPages: 1,
                    shapes: [expect.objectContaining({stableKey: 'evb-shape:shape-1'})],
                }),
            }),
            expect.any(Object),
        );
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
    });

    it('falls back to serialized save when dirty shapes are not native-eligible', async () => {
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(1),
            hasShapeChanges: vi.fn(() => true),
            getAllShapes: vi.fn(() => [createShapeAnnotation({x: 1.2})]),
            trySavePdfNativeMutations,
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('falls back to serialized save for metadata when generic native mutations are unavailable', async () => {
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(3),
            pageLabelsDirty: ref(true),
            pageLabelRanges: ref([{
                startPage: 1,
                style: 'r',
                prefix: '',
                startNumber: 1,
            }]),
            trySaveEmbeddedNoteTextUpdates: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/work.pdf',
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(deps.trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('uses the native note changes path for editor-only FreeText note upserts', async () => {
        const editorNote = createEditorFreeTextNote();
        const pendingTexts = new Map<string, string>();
        pendingTexts.set(editorNote.stableKey, editorNote.text);
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const markNativeFreeTextNotesSaved = vi.fn();
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([editorNote]),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            hasAnnotationChanges: vi.fn(() => true),
            markNativeFreeTextNotesSaved,
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).toHaveBeenCalledWith(
            [],
            expect.objectContaining({
                saveMode: 'rewrite',
                expectedWorkingPath: '/tmp/work.pdf',
                preserveLoadedSource: true,
                freeTextNotes: [expect.objectContaining({
                    pageIndex: 0,
                    stableKey: 'uid:0:pdfjs_internal_editor_0',
                    text: 'Editor note',
                    markerRect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.0016,
                        height: 0.0016,
                    },
                    author: 'Tester',
                    color: 'rgba(255, 204, 0, 0.8)',
                    createdAt: 1781009077000,
                })],
                modifiedAt: expect.stringMatching(/^D:\d{14}[+-]\d{2}'\d{2}'$/u),
            }),
        );
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(markNativeFreeTextNotesSaved).toHaveBeenCalledWith([expect.objectContaining({ stableKey: 'uid:0:pdfjs_internal_editor_0' })]);
    });

    it('materializes a saved PDF.js baseline even when replayable editor-only FreeText note work exists', async () => {
        const editorNote = createEditorFreeTextNote({text: 'Edited note'});
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const markNativeFreeTextNotesSaved = vi.fn();
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
            serializable: { map: new Map([[
                'pdfjs_internal_editor_0',
                {
                    annotationType: 3,
                    pageIndex: 0,
                    value: '',
                    comment: {
                        text: 'Edited note',
                        deleted: false,
                    },
                },
            ]]) },
        } }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([editorNote]),
            pdfDocument: livePdfDocument,
            hasAnnotationChanges: vi.fn(() => true),
            hasSavedPdfJsAnnotationBaselineChanges: vi.fn(() => true),
            markNativeFreeTextNotesSaved,
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
        expect(markNativeFreeTextNotesSaved).not.toHaveBeenCalled();
    });

    it('uses the native annotation changes path for editor-only FreeText note deletes', async () => {
        const pendingDeletes = [createEditorFreeTextNote()];
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const markNativeFreeTextNotesDeleted = vi.fn();
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([]),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => pendingDeletes),
            markNativeFreeTextNotesDeleted,
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).toHaveBeenCalledWith(
            [],
            expect.objectContaining({
                saveMode: 'rewrite',
                expectedWorkingPath: '/tmp/work.pdf',
                preserveLoadedSource: true,
                deletes: [{
                    pageIndex: 0,
                    stableKey: 'uid:0:pdfjs_internal_editor_0',
                    createdAt: 1781009077000,
                }],
                modifiedAt: expect.stringMatching(/^D:\d{14}[+-]\d{2}'\d{2}'$/u),
            }),
        );
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(markNativeFreeTextNotesDeleted).toHaveBeenCalledWith([expect.objectContaining({ stableKey: 'uid:0:pdfjs_internal_editor_0' })]);
    });

    it('materializes a saved PDF.js baseline even when replayable editor-only FreeText deletes exist', async () => {
        const pendingDeletes = [createEditorFreeTextNote()];
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const markNativeFreeTextNotesDeleted = vi.fn();
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([]),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => pendingDeletes),
            hasAnnotationChanges: vi.fn(() => true),
            hasSavedPdfJsAnnotationBaselineChanges: vi.fn(() => true),
            markNativeFreeTextNotesDeleted,
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
        expect(markNativeFreeTextNotesDeleted).not.toHaveBeenCalled();
    });

    it('uses the native annotation changes path for PDF-sourced annotation deletes', async () => {
        const pendingDeletes = [createPdfNoteComment()];
        const reloadWaiter = createDeferred<undefined>();
        const cancelReloadWaiter = vi.fn();
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => pendingDeletes),
            trySaveEmbeddedNoteTextUpdates,
            preparePostSaveReload: () => ({
                promise: reloadWaiter.promise,
                cancel: cancelReloadWaiter,
            }),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).toHaveBeenCalledWith(
            [],
            expect.objectContaining({
                saveMode: 'rewrite',
                expectedWorkingPath: '/tmp/work.pdf',
                preserveLoadedSource: true,
                deletes: [{
                    pageIndex: 0,
                    objectNumber: 3856,
                    generationNumber: 0,
                }],
                modifiedAt: expect.stringMatching(/^D:\d{14}[+-]\d{2}'\d{2}'$/u),
            }),
        );
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(cancelReloadWaiter).toHaveBeenCalledOnce();
    });

    it('uses the native note text save path when pending text is keyed by annotation id alias', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('3856R', 'Updated through alias');
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).toHaveBeenCalledWith(
            [{
                objectNumber: 3856,
                generationNumber: 0,
                text: 'Updated through alias',
            }],
            expect.any(Object),
        );
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
    });

    it('coalesces duplicate native note text aliases for the same PDF annotation', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated once');
        pendingTexts.set('3856R', 'Updated once');
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const { deps } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).toHaveBeenCalledWith(
            [{
                objectNumber: 3856,
                generationNumber: 0,
                text: 'Updated once',
            }],
            expect.any(Object),
        );
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
    });

    it('falls back to serialized save when duplicate native note aliases conflict', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'First update');
        pendingTexts.set('3856R', 'Second update');
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            trySaveEmbeddedNoteTextUpdates,
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).toHaveBeenCalledWith(
            new Uint8Array([9]),
            expect.objectContaining({pendingTexts}),
        );
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('falls back to serialized save when the native note text save path is not applied', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => null);
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            trySaveEmbeddedNoteTextUpdates,
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledWith(
            new Uint8Array([9]),
            expect.objectContaining({pendingTexts}),
        );
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('does not use the native note text save path for Save As', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveWorkingCopyAs,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([createPdfNoteComment()]),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSaveAs } = useFileOperationsSaveController(deps);

        const result = await handleSaveAs();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveWorkingCopyAs).toHaveBeenCalledOnce();
    });

    it('uses PDF.js saveDocument when annotation storage has serializable entries without modified ids', async () => {
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set() },
            serializable: {
                map: new Map([[
                    'ink-editor-1',
                    { path: 'M0 0L1 1' },
                ]]),
                hash: 'ink-hash',
                transfer: [],
            },
        } }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            pdfDocument: livePdfDocument,
            saveDocument: vi.fn(async () => new Uint8Array([11])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            11,
            2,
            3,
            6,
            4,
            5,
        ]);
    });

    it('uses source bytes for replayable new editor-only FreeText notes', async () => {
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([{
                id: 'editor-note-1',
                stableKey: 'editor:0:editor-note-1',
                sortIndex: null,
                pageIndex: 0,
                pageNumber: 1,
                text: 'fresh note',
                kindLabel: 'Note',
                subtype: 'FreeText',
                author: null,
                modifiedAt: Date.now(),
                color: null,
                uid: 'editor-uid-1',
                annotationId: null,
                source: 'editor',
                hasNote: true,
                markerRect: {
                    left: 0.1,
                    top: 0.1,
                    width: 0.01,
                    height: 0.01,
                },
            }]),
            saveDocument: vi.fn(async () => new Uint8Array([8])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            9,
            2,
            3,
            6,
            4,
            5,
        ]);
    });

    it('uses source bytes for replayable new editor-only FreeText notes with temporary non-ref ids', async () => {
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([{
                id: 'editor-note-2',
                stableKey: 'editor:0:editor-note-2',
                sortIndex: null,
                pageIndex: 0,
                pageNumber: 1,
                text: 'fresh note with temp id',
                kindLabel: 'Note',
                subtype: 'FreeText',
                author: null,
                modifiedAt: Date.now(),
                color: null,
                uid: 'editor-uid-2',
                annotationId: 'pdfjs_internal_editor_12',
                source: 'editor',
                hasNote: true,
                markerRect: {
                    left: 0.12,
                    top: 0.12,
                    width: 0.01,
                    height: 0.01,
                },
            }]),
            saveDocument: vi.fn(async () => new Uint8Array([10])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            9,
            2,
            3,
            6,
            4,
            5,
        ]);
    });

    it('waits for the post-save reload after clearing the visible save indicator', async () => {
        const deferredReload = createDeferred<undefined>();
        const cancel = vi.fn();
        const {
            deps,
            resetModified,
        } = createDeps({
            annotationDirty: ref(true),
            pageLabelsDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            preparePostSaveReload: () => ({
                promise: deferredReload.promise,
                cancel,
            }),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        let settled = false;
        const savePromise = handleSave().then(() => {
            settled = true;
        });

        await vi.waitFor(() => {
            expect(deps.saveFile).toHaveBeenCalledOnce();
        });
        expect(settled).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(deps.isSaving.value).toBe(false);
        });
        await expect(handleSave()).resolves.toBe(false);
        expect(deps.saveFile).toHaveBeenCalledOnce();
        expect(resetModified).not.toHaveBeenCalled();
        expectWorkspaceSaveNotMarked(deps);
        const adoptPersistedShapeStateForNextReload = vi.mocked(
            deps.adoptPersistedShapeStateForNextReload!,
        );
        const saveFile = vi.mocked(deps.saveFile);
        expect(adoptPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
        expect(
            adoptPersistedShapeStateForNextReload.mock.invocationCallOrder[0],
        ).toBeLessThan(saveFile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);

        deferredReload.resolve(undefined);
        await savePromise;

        expect(settled).toBe(true);
        expect(resetModified).toHaveBeenCalledOnce();
        expectWorkspaceSaveMarked(deps);
    });

    it('arms persisted shape adoption before the save mutates the working copy bytes', async () => {
        const saveOrder: string[] = [];
        const { deps } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            adoptPersistedShapeStateForNextReload: vi.fn(() => {
                saveOrder.push('adopt');
            }),
            saveFile: vi.fn(async () => {
                saveOrder.push('save-file');
                return {
                    success: true,
                    outPath: '/tmp/work.pdf',
                    saveMode: 'rewrite' as const,
                    didSaveAs: false,
                };
            }),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(saveOrder.slice(0, 2)).toEqual([
            'adopt',
            'save-file',
        ]);
    });

    it('prepares persisted managed shape state from the saved bytes before save mutates the working copy', async () => {
        const saveOrder: string[] = [];
        const { deps } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            preparePersistedShapeStateForSave: vi.fn(async () => {
                saveOrder.push('prepare');
                return { snapshot: true };
            }),
            adoptPersistedShapeStateForNextReload: vi.fn(() => {
                saveOrder.push('adopt');
            }),
            saveFile: vi.fn(async () => {
                saveOrder.push('save-file');
                return {
                    success: true,
                    outPath: '/tmp/work.pdf',
                    saveMode: 'rewrite' as const,
                    didSaveAs: false,
                };
            }),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(saveOrder.slice(0, 3)).toEqual([
            'prepare',
            'adopt',
            'save-file',
        ]);
        const preparePersistedShapeStateForSave = deps.preparePersistedShapeStateForSave!;
        expect(preparePersistedShapeStateForSave).toHaveBeenCalledOnce();
        const preparedBytes = vi.mocked(preparePersistedShapeStateForSave).mock.calls[0]![0];
        expect(Array.from(preparedBytes)).toEqual([
            1,
            2,
            3,
            6,
            4,
            5,
        ]);
        expect(deps.restorePreparedPersistedShapeState).not.toHaveBeenCalled();
    });

    it('marks shape state saved after persistence even when the post-save reload fails to restore', async () => {
        const { deps } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            preparePostSaveReload: () => ({
                promise: Promise.reject(new Error('reload failed')),
                cancel: vi.fn(),
            }),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expectWorkspaceSaveMarked(deps);
        expect(deps.adoptPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
    });

    it('serializes shape-only annotation saves from source bytes', async () => {
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            getSourcePdfData: vi.fn(async () => new Uint8Array([13])),
            saveDocument: vi.fn(async () => new Uint8Array([99])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            13,
            2,
            3,
            6,
            4,
            5,
        ]);
    });

    it('cancels the pending post-save reload waiter when save does not succeed', async () => {
        const deferredReload = createDeferred<undefined>();
        const cancel = vi.fn();
        const { deps } = createDeps({
            annotationDirty: ref(true),
            saveFile: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
            preparePostSaveReload: () => ({
                promise: deferredReload.promise,
                cancel,
            }),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(cancel).toHaveBeenCalledOnce();
        expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
        expect(deps.clearPendingPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
    });

    it('restores consumed embedded annotation updates when serialized persistence fails', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Unsaved retry text');
        const pendingDeletes = [{
            id: '3856R',
            stableKey: 'ann:0:3856R',
            sortIndex: null,
            pageIndex: 0,
            pageNumber: 1,
            text: 'Unsaved retry text',
            kindLabel: 'Note',
            subtype: 'FreeText',
            author: null,
            modifiedAt: Date.now(),
            color: null,
            uid: null,
            annotationId: '3856R',
            source: 'pdf',
            hasNote: true,
            markerRect: null,
        } satisfies IAnnotationCommentSummary];
        const { deps } = createDeps({
            annotationDirty: ref(true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => pendingDeletes),
            saveFile: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.restorePendingEmbeddedTextUpdates).toHaveBeenCalledWith(pendingTexts);
        expect(deps.restorePendingEmbeddedAnnotationDeletes).toHaveBeenCalledWith(pendingDeletes);
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
    });

    it('restores the prepared managed shape state when persistence fails after priming saved bytes', async () => {
        const snapshot = { snapshot: 'prepared' };
        const { deps } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            preparePersistedShapeStateForSave: vi.fn(async () => snapshot),
            saveFile: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        await handleSave();

        expect(deps.preparePersistedShapeStateForSave).toHaveBeenCalledOnce();
        expect(deps.restorePreparedPersistedShapeState).toHaveBeenCalledOnce();
        expect(deps.restorePreparedPersistedShapeState).toHaveBeenCalledWith(snapshot);
        expect(deps.clearPendingPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
    });

    it('cancels the pending post-save reload waiter when Save As is canceled without dirty changes', async () => {
        const deferredReload = createDeferred<undefined>();
        const cancel = vi.fn();
        const { deps } = createDeps({
            saveWorkingCopyAs: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'save_as_rewrite' as const,
                didSaveAs: true,
            })),
            preparePostSaveReload: () => ({
                promise: deferredReload.promise,
                cancel,
            }),
        });
        const { handleSaveAs } = useFileOperationsSaveController(deps);

        await handleSaveAs();

        expect(cancel).toHaveBeenCalledOnce();
        expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
        expect(deps.clearPendingPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
    });

    it('surfaces a toast and stops the saving state when PDF.js saveDocument stalls', async () => {
        vi.useFakeTimers();
        const stalledSave = new Promise<Uint8Array | null>(() => undefined);
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['3856R']) },
        } }));
        const { deps } = createDeps({
            annotationDirty: ref(true),
            pdfDocument: livePdfDocument,
            saveDocument: vi.fn(() => stalledSave),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        try {
            const savePromise = handleSave();
            await vi.advanceTimersByTimeAsync(0);
            expect(deps.saveDocument).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(PDF_SAVE_TIMEOUT_MS);
            await vi.advanceTimersByTimeAsync(2_000);
            await savePromise;

            expect(deps.serializePdfForSave).not.toHaveBeenCalled();
            expect(deps.saveFile).not.toHaveBeenCalled();
            expect(deps.isSaving.value).toBe(false);
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                title: 'errors.file.save',
                description: 'PDF.js saveDocument timed out',
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('blocks same-tick duplicate save calls before note persistence awaits', async () => {
        const deferredNotes = createDeferred<boolean>();
        const { deps } = createDeps({
            annotationNoteWindowsCount: ref(1),
            persistAllAnnotationNotes: vi.fn(() => deferredNotes.promise),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const firstSave = handleSave();
        const secondSave = await handleSave();

        expect(secondSave).toBe(false);
        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledOnce();
        expect(deps.isSaving.value).toBe(true);

        deferredNotes.resolve(true);
        await firstSave;

        expect(deps.isSaving.value).toBe(false);
    });

    it('surfaces a toast when PDF.js saveDocument returns no data repeatedly', async () => {
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['3856R']) },
        } }));
        const { deps } = createDeps({
            annotationDirty: ref(true),
            pdfDocument: livePdfDocument,
            saveDocument: vi.fn(async () => null),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(false);
        expect(deps.saveDocument).toHaveBeenCalledTimes(4);
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.isSaving.value).toBe(false);
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: 'saveDocument returned no data',
        }));
    });

    it('falls back to source bytes when deferred embedded note updates make PDF.js saveDocument stall', async () => {
        vi.useFakeTimers();
        const stalledSave = new Promise<Uint8Array | null>(() => undefined);
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['3856R']) },
        } }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            pdfDocument: livePdfDocument,
            saveDocument: vi.fn(() => stalledSave),
            getSourcePdfData: vi.fn(async () => new Uint8Array([42])),
            consumePendingEmbeddedTextUpdates: vi.fn(() => new Map([[
                'ann:0:3856R',
                'persist me',
            ]])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        try {
            const result = await handleSave();

            expect(result).toBe(true);
            expect(deps.saveDocument).not.toHaveBeenCalled();
            expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
            expect(deps.serializePdfForSave).toHaveBeenCalledWith(
                new Uint8Array([42]),
                expect.objectContaining({ pendingTexts: expect.any(Map) }),
            );
            expect(saveFile).toHaveBeenCalledOnce();
            expect(deps.isSaving.value).toBe(false);
            expect(toastAddMock).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('replays new editor-only FreeText note saves from source bytes instead of calling PDF.js saveDocument', async () => {
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        } }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([{
                id: 'editor:0:pdfjs_internal_editor_0',
                stableKey: 'uid:0:pdfjs_internal_editor_0',
                sortIndex: null,
                pageIndex: 0,
                pageNumber: 1,
                text: 'persist me',
                kindLabel: 'Note',
                subtype: 'FreeText',
                author: null,
                modifiedAt: null,
                color: null,
                uid: 'pdfjs_internal_editor_0',
                annotationId: null,
                source: 'editor',
                hasNote: true,
                markerRect: {
                    left: 0.2,
                    top: 0.2,
                    width: 0.01,
                    height: 0.01,
                },
            } satisfies IAnnotationCommentSummary]),
            pdfDocument: livePdfDocument,
            consumePendingEmbeddedTextUpdates: vi.fn(() => new Map([[
                'uid:0:pdfjs_internal_editor_0',
                'persist me',
            ]])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledWith(
            new Uint8Array([1]),
            expect.objectContaining({ pendingTexts: expect.any(Map) }),
        );
        expect(saveFile).toHaveBeenCalledOnce();
        expect(toastAddMock).not.toHaveBeenCalled();
    });

    it('treats PDF.js serializable FreeText editor storage as covered by pending embedded note text', async () => {
        const annotationStorage = {
            resetModified: vi.fn(),
            serializable: { map: new Map([[
                'pdfjs_internal_editor_0',
                {
                    annotationType: 3,
                    pageIndex: 0,
                    rect: [
                        120,
                        650,
                        132,
                        662,
                    ],
                    rotation: 0,
                    fontSize: 10,
                    color: [
                        0,
                        0,
                        0,
                    ],
                    value: '',
                    popup: {
                        contents: 'persist me',
                        deleted: false,
                        rect: [
                            133,
                            562,
                            313,
                            662,
                        ],
                    },
                },
            ]]) },
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        };
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([{
                id: 'editor:0:pdfjs_internal_editor_0',
                stableKey: 'src:editor:0:pdfjs_internal_editor_0',
                sortIndex: null,
                pageIndex: 0,
                pageNumber: 1,
                text: 'persist me',
                kindLabel: 'Note',
                subtype: 'FreeText',
                author: null,
                modifiedAt: null,
                color: null,
                uid: null,
                annotationId: null,
                source: 'editor',
                hasNote: true,
                markerRect: {
                    left: 0.2,
                    top: 0.2,
                    width: 0.01,
                    height: 0.01,
                },
            } satisfies IAnnotationCommentSummary]),
            pdfDocument: livePdfDocument,
            consumePendingEmbeddedTextUpdates: vi.fn(() => new Map([[
                'src:editor:0:pdfjs_internal_editor_0',
                'persist me',
            ]])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledWith(
            new Uint8Array([1]),
            expect.objectContaining({ pendingTexts: expect.any(Map) }),
        );
        expect(saveFile).toHaveBeenCalledOnce();
        expect(toastAddMock).not.toHaveBeenCalled();
    });

    it('matches nested editor stable keys to PDF.js runtime ids for replayable notes', async () => {
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        } }));
        const nestedStableKey = 'src:editor:0:editor:0:pdfjs_internal_editor_0';
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([{
                id: 'editor:0:pdfjs_internal_editor_0',
                stableKey: nestedStableKey,
                sortIndex: null,
                pageIndex: 0,
                pageNumber: 1,
                text: 'persist me',
                kindLabel: 'Note',
                subtype: 'Typewriter',
                author: null,
                modifiedAt: null,
                color: null,
                uid: null,
                annotationId: null,
                source: 'editor',
                hasNote: true,
                markerRect: {
                    left: 0.2,
                    top: 0.2,
                    width: 0.01,
                    height: 0.01,
                },
            } satisfies IAnnotationCommentSummary]),
            pdfDocument: livePdfDocument,
            consumePendingEmbeddedTextUpdates: vi.fn(() => new Map([[
                nestedStableKey,
                'persist me',
            ]])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
        expect(toastAddMock).not.toHaveBeenCalled();
    });

    it('treats blank PDF.js FreeText storage as replayable when app note ids drift', async () => {
        const runtimeStableKey = 'src:editor:0:runtime-0-1';
        const annotationStorage = {
            resetModified: vi.fn(),
            serializable: { map: new Map([[
                'pdfjs_internal_editor_0',
                {
                    annotationType: 3,
                    pageIndex: 0,
                    rect: [
                        120,
                        650,
                        121,
                        651,
                    ],
                    rotation: 0,
                    fontSize: 10,
                    color: [
                        0,
                        0,
                        0,
                    ],
                    value: '',
                },
            ]]) },
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        };
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([{
                id: 'runtime-0-1',
                stableKey: runtimeStableKey,
                sortIndex: null,
                pageIndex: 0,
                pageNumber: 1,
                text: 'persist me',
                kindLabel: 'Note',
                subtype: 'Typewriter',
                author: null,
                modifiedAt: null,
                color: null,
                uid: null,
                annotationId: null,
                source: 'editor',
                hasNote: true,
                markerRect: {
                    left: 0.2,
                    top: 0.2,
                    width: 0.01,
                    height: 0.01,
                },
            } satisfies IAnnotationCommentSummary]),
            pdfDocument: livePdfDocument,
            consumePendingEmbeddedTextUpdates: vi.fn(() => new Map([[
                runtimeStableKey,
                'persist me',
            ]])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
        expect(toastAddMock).not.toHaveBeenCalled();
    });

    it('ignores PDF.js nullish modified ids for replayable new FreeText notes', async () => {
        const runtimeStableKey = 'src:editor:0:runtime-0-1';
        const annotationStorage = {
            resetModified: vi.fn(),
            serializable: { map: new Map([[
                'pdfjs_internal_editor_0',
                {
                    annotationType: 3,
                    pageIndex: 0,
                    rect: [
                        120,
                        650,
                        121,
                        651,
                    ],
                    rotation: 0,
                    fontSize: 10,
                    color: [
                        0,
                        0,
                        0,
                    ],
                    value: '\u200B',
                    comment: {
                        text: 'persist me',
                        deleted: false,
                    },
                },
            ]]) },
            modifiedIds: { ids: new Set([undefined]) },
        };
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            annotationComments: ref([{
                id: 'runtime-0-1',
                stableKey: runtimeStableKey,
                sortIndex: null,
                pageIndex: 0,
                pageNumber: 1,
                text: 'persist me',
                kindLabel: 'Note',
                subtype: 'Typewriter',
                author: null,
                modifiedAt: null,
                color: null,
                uid: null,
                annotationId: null,
                source: 'editor',
                hasNote: true,
                markerRect: {
                    left: 0.2,
                    top: 0.2,
                    width: 0.01,
                    height: 0.01,
                },
            } satisfies IAnnotationCommentSummary]),
            pdfDocument: livePdfDocument,
            consumePendingEmbeddedTextUpdates: vi.fn(() => new Map([[
                runtimeStableKey,
                'persist me',
            ]])),
        });
        const { handleSave } = useFileOperationsSaveController(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
        expect(toastAddMock).not.toHaveBeenCalled();
    });
});
