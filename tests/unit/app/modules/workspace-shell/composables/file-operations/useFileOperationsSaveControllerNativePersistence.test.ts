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
    useFileOperationsSaveController,
} from '@tests/unit/app/modules/workspace-shell/composables/file-operations/useFileOperationsSaveControllerFixture';

describe('useFileOperationsSaveController native persistence', () => {
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
        const cancelReloadWaiter = vi.fn();
        const preparePostSaveReload = vi.fn(() => ({
            promise: Promise.resolve(),
            cancel: cancelReloadWaiter,
        }));
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
            preparePostSaveReload,
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
        expect(preparePostSaveReload).not.toHaveBeenCalled();
        expect(cancelReloadWaiter).not.toHaveBeenCalled();
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
