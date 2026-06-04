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
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { PDF_SAVE_TIMEOUT_MS } from '@app/constants/timeouts';
import { useFileOperations } from '@app/composables/useFileOperations';
import { cast } from '@tests/helpers/cast';

const toastAddMock = vi.fn();

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

function createDeps(overrides: Partial<Parameters<typeof useFileOperations>[0]> = {}) {
    const resetModified = vi.fn();
    const saveFile = vi.fn(async (_data: Uint8Array) => ({
        success: true,
        outPath: '/tmp/work.pdf',
        saveMode: 'rewrite' as const,
        didSaveAs: false,
    }));
    const saveWorkingCopyAs = vi.fn(async (_data?: Uint8Array) => ({
        success: true,
        outPath: '/tmp/new.pdf',
        saveMode: 'save_as_rewrite' as const,
        didSaveAs: true,
    }));

    return {
        deps: cast<Parameters<typeof useFileOperations>[0]>({
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

describe('useFileOperations', () => {
    beforeEach(() => {
        toastAddMock.mockClear();
    });

    it('serializes and saves when working copy has pending annotation-related changes', async () => {
        const {
            deps,
            resetModified,
            saveFile,
        } = createDeps({annotationDirty: ref(true)});
        const { handleSave } = useFileOperations(deps);

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
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
        expect(deps.isSaving.value).toBe(false);
        expect(deps.validatePdfPath).not.toHaveBeenCalled();
    });

    it('saves working copy directly when no serialization work is required', async () => {
        const { deps } = createDeps();
        const { handleSave } = useFileOperations(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.validatePdfPath).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
    });

    it('repair-saves by forcing a serialized rewrite even when the document is clean', async () => {
        const {
            deps,
            saveFile,
        } = createDeps();
        const { handleRepairSave } = useFileOperations(deps);

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
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
    });

    it('preserves annotation undo history after a successful save', async () => {
        const clearAnnotationHistory = vi.fn();
        const { deps } = createDeps({
            annotationDirty: ref(true),
            clearAnnotationHistory,
        });
        const { handleSave } = useFileOperations(deps);

        await handleSave();

        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(clearAnnotationHistory).not.toHaveBeenCalled();
    });

    it('serializes on save-as and refreshes recent files when path is returned', async () => {
        const {
            deps,
            resetModified,
            saveWorkingCopyAs,
        } = createDeps({annotationDirty: ref(true)});
        const { handleSaveAs } = useFileOperations(deps);

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

    it('aborts save early when note windows cannot be persisted', async () => {
        const { deps } = createDeps({
            annotationNoteWindowsCount: ref(2),
            persistAllAnnotationNotes: vi.fn(async () => false),
        });
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

        await handleSave();

        expect(deps.saveFile).not.toHaveBeenCalled();
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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
        expect(deps.markPageLabelsSaved).not.toHaveBeenCalled();
        expect(deps.markBookmarksSaved).not.toHaveBeenCalled();
        expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
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
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

        await handleSave();

        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSaveAs } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

        try {
            const savePromise = handleSave();
            await vi.advanceTimersByTimeAsync(0);
            expect(deps.saveDocument).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(PDF_SAVE_TIMEOUT_MS);
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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

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
        const { handleSave } = useFileOperations(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
        expect(toastAddMock).not.toHaveBeenCalled();
    });
});
