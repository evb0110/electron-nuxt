import {
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
import { PDF_SAVE_TIMEOUT_MS } from '@app/constants/timeouts';
import { useFileOperations } from '@app/composables/useFileOperations';

function cast<T>(value: unknown): T {
    return value as T;
}

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
            workingCopyPath: ref('/tmp/work.pdf'),
            annotationDirty: ref(false),
            annotationComments: ref([]),
            pageLabelsDirty: ref(false),
            bookmarksDirty: ref(false),
            pdfDocument: shallowRef(cast({ annotationStorage: { resetModified } })),
            saveDocument: vi.fn(async () => new Uint8Array([1])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([1])),
            readWorkingCopyBytes: vi.fn(async () => new Uint8Array([1])),
            validatePdfData: vi.fn(async () => ({
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
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
            annotationNoteWindowsCount: ref(0),
            loadRecentFiles: vi.fn(),
            ...overrides,
        }),
        resetModified,
        saveFile,
        saveWorkingCopyAs,
    };
}

describe('useFileOperations', () => {
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
        expect(deps.isSaving.value).toBe(false);
        expect(deps.validatePdfData).toHaveBeenCalledOnce();
    });

    it('saves working copy directly when no serialization work is required', async () => {
        const { deps } = createDeps();
        const { handleSave } = useFileOperations(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.readWorkingCopyBytes).toHaveBeenCalledOnce();
        expect(deps.validatePdfData).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
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
        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
        expect(deps.isSavingAs.value).toBe(false);
        expect(deps.validatePdfData).toHaveBeenCalledOnce();
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
        const { deps } = createDeps({
            annotationDirty: ref(true),
            validatePdfData: vi.fn(async () => ({
                isValid: false,
                tool: 'qpdf' as const,
                errors: ['broken pdf'],
                warnings: [],
            })),
        });
        const { handleSave } = useFileOperations(deps);

        await handleSave();

        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
    });

    it('uses PDF.js saveDocument when live annotation storage has modified ids', async () => {
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['annot-1']) },
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

    it('uses PDF.js saveDocument for editor-only annotations that are not yet materialized', async () => {
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

        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            8,
            2,
            3,
            6,
            4,
            5,
        ]);
    });

    it('uses PDF.js saveDocument for editor-only annotations with temporary non-ref ids', async () => {
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

        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            10,
            2,
            3,
            6,
            4,
            5,
        ]);
    });

    it('waits for the post-save reload to restore the viewer state after a successful save', async () => {
        const deferredReload = createDeferred<undefined>();
        const cancel = vi.fn();
        const { deps } = createDeps({
            annotationDirty: ref(true),
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

        deferredReload.resolve(undefined);
        await savePromise;

        expect(settled).toBe(true);
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
    });

    it('stops the saving state when PDF.js saveDocument stalls', async () => {
        vi.useFakeTimers();
        const stalledSave = new Promise<Uint8Array | null>(() => undefined);
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['annot-1']) },
        } }));
        const { deps } = createDeps({
            annotationDirty: ref(true),
            pdfDocument: livePdfDocument,
            saveDocument: vi.fn(() => stalledSave),
        });
        const { handleSave } = useFileOperations(deps);

        try {
            const savePromise = handleSave();
            await vi.advanceTimersByTimeAsync(PDF_SAVE_TIMEOUT_MS);
            await savePromise;

            expect(deps.saveDocument).toHaveBeenCalledOnce();
            expect(deps.serializePdfForSave).not.toHaveBeenCalled();
            expect(deps.saveFile).not.toHaveBeenCalled();
            expect(deps.isSaving.value).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
