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
import { cast } from '@tests/helpers/cast';
import {
    createDeferred,
    createDeps,
    createEditorFreeTextNote,
    createPdfNoteComment,
    createShapeAnnotation,
    expectWorkspaceSaveMarked,
    expectWorkspaceSaveNotMarked,
    toastAddMock,
    useWorkspaceSaveServiceForTest,
} from '@tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceFixture';

describe('workspaceSaveService native persistence', () => {
    beforeEach(() => {
        toastAddMock.mockClear();
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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
                expectedDocumentRevisionToken: 'rev-1',
                preserveLoadedSource: true,
            }),
        );
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.preparePersistedShapeStateForSave).toHaveBeenCalledWith(savedBytes);
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(deps.trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('fails the save instead of falling back when native staged commit persistence rejects', async () => {
        const trySavePdfNativeMutations = vi.fn(async () => {
            throw new Error('Staged artifact content changed after staging');
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
            trySavePdfNativeMutations,
        });
        const {handleSave} = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(false);

        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(saveFile).not.toHaveBeenCalled();
        expectWorkspaceSaveNotMarked(deps);
    });

    it('materializes a saved PDF.js baseline even when replayable editor-only FreeText deletes exist', async () => {
        const pendingDeletes = [createEditorFreeTextNote()];
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
            canonicalAnnotationComments: ref([]),
            captureCanonicalPendingAnnotationDeletes: vi.fn(() => pendingDeletes),
            hasAnnotationChanges: vi.fn(() => true),
            hasSavedPdfJsAnnotationBaselineChanges: vi.fn(() => true),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
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
            canonicalAnnotationComments: ref([createPdfNoteComment()]),
            captureCanonicalPendingTextUpdates: vi.fn(() => pendingTexts),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSaveAs } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
            captureCanonicalPendingTextUpdates: vi.fn(() => pendingTexts),
            captureCanonicalPendingAnnotationDeletes: vi.fn(() => pendingDeletes),
            saveFile: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSaveAs } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
});
