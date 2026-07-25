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
import { createStaleRevisionError } from '@contracts/documentMutationErrors';
import type { IPdfSerializedCommitCallbacks } from '@contracts/electronApiDocuments';
import { cast } from '@tests/helpers/cast';
import {
    createDeferred,
    createDeps,
    createPdfNoteComment,
    expectWorkspaceSaveMarked,
    expectWorkspaceSaveNotMarked,
    toastAddMock,
    type TPdfNativeMutationSave,
    useWorkspaceSaveServiceForTest,
} from '@tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceFixture';
import {requireDocumentRevisionToken} from '@contracts';

describe('workspaceSaveService', () => {
    beforeEach(() => {
        toastAddMock.mockClear();
    });

    it('serializes and saves when working copy has pending annotation-related changes', async () => {
        const {
            deps,
            resetModified,
            saveFile,
        } = createDeps({annotationDirty: ref(true)});
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(saveFile).toHaveBeenCalledOnce();
        expect(saveFile.mock.calls[0]?.[1]).toMatchObject({
            expectedWorkingPath: '/tmp/work.pdf',
            expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-1'),
        });
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

    it('rebuilds and retries a serialized save after a stale revision rejection', async () => {
        const sourceBytes = [
            new Uint8Array([1]),
            new Uint8Array([9]),
        ];
        const getSourcePdfData = vi.fn(async () => sourceBytes.shift() ?? new Uint8Array([0]));
        const saveFile = vi.fn()
            .mockRejectedValueOnce(createStaleRevisionError({
                documentRef: '/tmp/work.pdf',
                expectedRevision: requireDocumentRevisionToken('drt1:test:before-save'),
                actualRevision: requireDocumentRevisionToken('drt1:test:page-op'),
            }))
            .mockResolvedValueOnce({
                success: true,
                outPath: '/tmp/work.pdf',
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            });
        const { deps } = createDeps({
            annotationDirty: ref(true),
            getSourcePdfData,
            saveFile,
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(true);

        expect(getSourcePdfData).toHaveBeenCalledTimes(2);
        expect(deps.serializePdfForSave).toHaveBeenCalledTimes(2);
        expect(saveFile).toHaveBeenCalledTimes(2);
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            1,
            2,
            3,
            6,
            4,
            5,
        ]);
        expect(Array.from(saveFile.mock.calls[1]?.[0] ?? [])).toEqual([
            9,
            2,
            3,
            6,
            4,
            5,
        ]);
        expect(toastAddMock).not.toHaveBeenCalled();
        expectWorkspaceSaveMarked(deps);
    });

    it('stops stale revision save retries after the bounded retry budget', async () => {
        const staleError = createStaleRevisionError({
            documentRef: '/tmp/work.pdf',
            expectedRevision: requireDocumentRevisionToken('drt1:test:before-save'),
            actualRevision: requireDocumentRevisionToken('drt1:test:ocr-apply'),
        });
        const saveFile = vi.fn(async () => {
            throw staleError;
        });
        const { deps } = createDeps({
            annotationDirty: ref(true),
            getSourcePdfData: vi.fn(async () => new Uint8Array([1])),
            saveFile,
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(false);

        expect(deps.getSourcePdfData).toHaveBeenCalledTimes(3);
        expect(deps.serializePdfForSave).toHaveBeenCalledTimes(3);
        expect(saveFile).toHaveBeenCalledTimes(3);
        expectWorkspaceSaveNotMarked(deps);
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: 'Document changed while this edit was being prepared',
        }));
    });

    it('saves working copy directly when no serialization work is required', async () => {
        const { deps } = createDeps();
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.validatePdfPath).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).toHaveBeenCalledWith({
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/work.pdf',
            expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-1'),
        });
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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
            canonicalAnnotationComments: ref([createPdfNoteComment()]),
            annotationNoteWindowsCount: ref(1),
            captureCanonicalPendingTextUpdates: vi.fn(() => pendingTexts),
            persistAllAnnotationNotes: vi.fn(() => notePersistence.promise),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const savePromise = handleSave();
        await Promise.resolve();

        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledWith(true);
        deps.originalPath.value = '/tmp/different-source.pdf';
        notePersistence.resolve(true);

        await expect(savePromise).resolves.toBe(false);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expectWorkspaceSaveNotMarked(deps);
        expect(deps.isSaving.value).toBe(false);
    });

    it('skips serialized persistence when the original target changes after the transaction is prepared', async () => {
        const sourceBytes = createDeferred<Uint8Array>();
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const { deps } = createDeps({
            annotationDirty: ref(true),
            hasPreservedAnnotationSourceChanges: vi.fn(() => true),
            captureCanonicalPendingTextUpdates: vi.fn(() => pendingTexts),
            saveDocument: vi.fn(() => sourceBytes.promise),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const savePromise = handleSave();

        await vi.waitFor(() => {
            expect(deps.saveDocument).toHaveBeenCalledOnce();
        });
        deps.originalPath.value = '/tmp/different-source.pdf';
        sourceBytes.resolve(new Uint8Array([1]));

        await expect(savePromise).resolves.toBe(false);
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expectWorkspaceSaveNotMarked(deps);
        expect(deps.isSaving.value).toBe(false);
    });

    it('skips serialized persistence when the working copy target changes after the transaction is prepared', async () => {
        const sourceBytes = createDeferred<Uint8Array | null>();
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const { deps } = createDeps({
            annotationDirty: ref(true),
            captureCanonicalPendingTextUpdates: vi.fn(() => pendingTexts),
            getSourcePdfData: vi.fn(() => sourceBytes.promise),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const savePromise = handleSave();

        await vi.waitFor(() => {
            expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        });
        deps.workingCopyPath.value = '/tmp/other-work.pdf';
        sourceBytes.resolve(new Uint8Array([1]));

        await expect(savePromise).resolves.toBe(false);
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const savePromise = handleSave();

        await vi.waitFor(() => {
            expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        });
        deps.workingCopyPath.value = '/tmp/other-work.pdf';
        sourceBytes.resolve(new Uint8Array([1]));

        await expect(savePromise).resolves.toBe(false);
        expect(cancel).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
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
            canonicalAnnotationComments: ref([createPdfNoteComment()]),
            annotationNoteWindowsCount: ref(1),
            captureCanonicalPendingTextUpdates: vi.fn(() => pendingTexts),
            persistAllAnnotationNotes: vi.fn(() => notePersistence.promise),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const savePromise = handleSave();
        await Promise.resolve();

        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledWith(true);
        deps.workingCopyPath.value = '/tmp/other-work.pdf';
        notePersistence.resolve(true);

        await expect(savePromise).resolves.toBe(false);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(deps.saveFile).not.toHaveBeenCalled();
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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleRepairSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(true);

        expect(saveFile).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).toHaveBeenCalledWith({ preserveLivePdfjsSession: true });
    });

    it('commits persisted annotation identities before capturing the successful-save baseline', async () => {
        let annotationToken = 'annotation-before';
        const commitAnnotationSave = vi.fn(() => {
            annotationToken = 'annotation-after-identity-adoption';
        });
        const markAnnotationSaved = vi.fn(() => {
            expect(annotationToken).toBe('annotation-after-identity-adoption');
        });
        const runSaveTransaction = vi.fn(async () => {
            annotationToken = 'annotation-after-materialize';
            return cast({
                source: 'pdfjs-materialize',
                baseBytes: new Uint8Array([9]),
                serializedBytes: new Uint8Array([9]),
                serializedResult: null,
                nativeMutationProjection: null,
                verifyAnnotationSave: vi.fn(async () => undefined),
                assertAnnotationSaveCurrent: vi.fn(async () => undefined),
                commitAnnotationSave,
            });
        });
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            getAnnotationSaveStateToken: () => annotationToken,
            hasAnnotationChanges: vi.fn(() => true),
            markAnnotationSaved,
            runSaveTransaction,
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(true);

        expect(saveFile).toHaveBeenCalledOnce();
        expect(commitAnnotationSave).toHaveBeenCalledOnce();
        expect(markAnnotationSaved).toHaveBeenCalledWith({ preserveLivePdfjsSession: true });
    });

    it('hands serialized verification and frontier assertions to the persistence commit boundary', async () => {
        const verifyAnnotationSave = vi.fn(async () => undefined);
        const verifyAnnotationSavePath = vi.fn(async () => undefined);
        const assertAnnotationSaveCurrent = vi.fn();
        const finalBytes = new Uint8Array([
            8,
            9,
        ]);
        const saveFile = vi.fn(async (
            _data: Uint8Array,
            options: {commitCallbacks?: IPdfSerializedCommitCallbacks},
        ) => {
            expect(verifyAnnotationSave).not.toHaveBeenCalled();
            await options.commitCallbacks?.verifyPathBeforeCommit?.('/tmp/staged.pdf', finalBytes.byteLength);
            await options.commitCallbacks?.assertBeforeCommit?.();
            return {
                success: true,
                outPath: '/tmp/work.pdf',
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const runSaveTransaction = vi.fn(async () => cast({
            source: 'serialized-rewrite',
            baseBytes: new Uint8Array([1]),
            serializedBytes: new Uint8Array([2]),
            serializedResult: {
                finalBytes,
                saveMode: 'rewrite',
                source: 'serialized-rewrite',
                changedObjectRefs: ['12 0 R'],
            },
            nativeMutationProjection: null,
            verifyAnnotationSave,
            verifyAnnotationSavePath,
            assertAnnotationSaveCurrent,
        }));
        const {deps} = createDeps({
            annotationDirty: ref(true),
            runSaveTransaction,
            saveFile,
        });
        const {handleSave} = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(true);

        expect(saveFile).toHaveBeenCalledWith(finalBytes, expect.objectContaining({
            changedObjectRefs: ['12 0 R'],
            commitCallbacks: {
                verifyBytesBeforeCommit: verifyAnnotationSave,
                verifyPathBeforeCommit: verifyAnnotationSavePath,
                assertBeforeCommit: assertAnnotationSaveCurrent,
            },
        }));
        expect(verifyAnnotationSavePath).toHaveBeenCalledWith('/tmp/staged.pdf', finalBytes.byteLength);
        expect(assertAnnotationSaveCurrent).toHaveBeenCalledOnce();
        expect(verifyAnnotationSave).not.toHaveBeenCalled();
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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleRepairSave } = useWorkspaceSaveServiceForTest(deps);

        await handleRepairSave();

        expect(repairWorkingCopy).toHaveBeenCalledWith({
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/work.pdf',
            expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-1'),
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
        const { handleOptimizePdfForInteraction } = useWorkspaceSaveServiceForTest(deps);

        await handleOptimizePdfForInteraction();

        expect(optimizeWorkingCopy).toHaveBeenCalledWith({
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/work.pdf',
            expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-1'),
        });
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.validatePdfPath).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expectWorkspaceSaveMarked(deps);
    });

    it('keeps edits made during native working-copy persistence dirty', async () => {
        let annotationToken = 'annotation-before';
        const repairWorkingCopy = vi.fn(async () => {
            annotationToken = 'annotation-after-newer-edit';
            return {
                success: true,
                outPath: '/tmp/work.pdf',
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const {deps} = createDeps({
            repairWorkingCopy,
            getAnnotationSaveStateToken: () => annotationToken,
        });
        const {handleRepairSave} = useWorkspaceSaveServiceForTest(deps);

        await expect(handleRepairSave()).resolves.toBe(true);

        expect(repairWorkingCopy).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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

    it('allows the large serialized-save benchmark only behind both automation gates', async () => {
        const getWorkingCopySize = vi.fn(async () => 512 * 1024 * 1024 + 1);
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            getWorkingCopySize,
        });
        vi.stubGlobal('window', {
            __allowRendererFileOpenForAutomation: vi.fn(async () => true),
            __allowLargeSerializedSaveForAutomation: true,
        });
        try {
            const {handleSave} = useWorkspaceSaveServiceForTest(deps);

            await expect(handleSave()).resolves.toBe(true);

            expect(getWorkingCopySize).toHaveBeenCalledWith('/tmp/work.pdf');
            expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
            expect(saveFile).toHaveBeenCalledOnce();
        } finally {
            vi.stubGlobal('window', undefined);
        }
    });

    it('saves clean Save As from the working copy without serialization', async () => {
        const {
            deps,
            saveWorkingCopyAs,
        } = createDeps();
        const { handleSaveAs } = useWorkspaceSaveServiceForTest(deps);

        await handleSaveAs();

        expect(deps.validatePdfPath).toHaveBeenCalledOnce();
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveWorkingCopyAs).toHaveBeenCalledWith(undefined, {
            saveMode: 'save_as_rewrite',
            expectedWorkingPath: '/tmp/work.pdf',
            optimizeLossless: false,
            expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-1'),
        });
        expectWorkspaceSaveMarked(deps);
    });

    it('serializes on save-as and refreshes recent files when path is returned', async () => {
        const {
            deps,
            resetModified,
            saveWorkingCopyAs,
        } = createDeps({annotationDirty: ref(true)});
        const { handleSaveAs } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSaveAs } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

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

    it('uses the native PDF mutation path for page labels and bookmarks', async () => {
        const preparePostSaveReload = vi.fn(() => ({
            promise: Promise.resolve(),
            cancel: vi.fn(),
        }));
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
            preparePostSaveReload,
            trySavePdfNativeMutations,
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(deps.runSaveTransaction).toHaveBeenCalledWith(expect.objectContaining({
            planOnly: true,
            serializeResult: false,
        }));
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
        expect(preparePostSaveReload).not.toHaveBeenCalled();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
    });

    it('executes the classifier-owned fallback without planning another route after native persistence declines', async () => {
        const trySavePdfNativeMutations = vi.fn(async () => null);
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

        await expect(handleSave()).resolves.toBe(true);

        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(deps.runSaveTransaction).toHaveBeenCalledOnce();
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('reclassifies only in the outer retry when native decline exposes a newer annotation mutation', async () => {
        const serializableMap = new Map<string, unknown>();
        const modifiedIds = new Set<string>();
        const pdfDocument = shallowRef(cast<PDFDocumentProxy>({
            numPages: 3,
            annotationStorage: {
                serializable: {
                    map: serializableMap,
                    get hash() {
                        return `${serializableMap.size}`;
                    },
                },
                modifiedIds: {ids: modifiedIds},
                resetModified: vi.fn(),
            },
        }));
        const trySavePdfNativeMutations = vi.fn(async () => {
            serializableMap.set('late-editor', {
                annotationType: 3,
                value: 'authored during native attempt',
            });
            modifiedIds.add('late-editor');
            return null;
        });
        const {
            deps,
            saveFile,
        } = createDeps({
            pdfDocument,
            totalPages: ref(3),
            pageLabelsDirty: ref(true),
            pageLabelRanges: ref([{
                startPage: 1,
                style: 'D',
                prefix: '',
                startNumber: 1,
            }]),
            hasLivePdfJsAnnotationChanges: () => modifiedIds.size > 0,
            trySavePdfNativeMutations,
        });
        const {handleSave} = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(true);

        // Attempt A owns one classifier/frontier. Its continuation observes the
        // mutation and fails stale; attempt B owns the only reclassification.
        expect(deps.runSaveTransaction).toHaveBeenCalledTimes(2);
        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
    });

    it('keeps unrelated annotation edits made during native mutation persistence dirty', async () => {
        let annotationToken = 'annotation-before';
        const trySavePdfNativeMutations = vi.fn(async () => {
            annotationToken = 'annotation-after-newer-edit';
            return {
                success: true,
                outPath: '/tmp/work.pdf',
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const {deps} = createDeps({
            totalPages: ref(3),
            pageLabelsDirty: ref(true),
            pageLabelRanges: ref([{
                startPage: 1,
                style: 'D',
                prefix: '',
                startNumber: 1,
            }]),
            trySavePdfNativeMutations,
            getAnnotationSaveStateToken: () => annotationToken,
        });
        const {handleSave} = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(true);

        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
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
            canonicalAnnotationComments: ref([]),
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
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).not.toHaveBeenCalled();
        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('propagates the optimization plan revision token to optimize-copy persistence', async () => {
        const optimizeWorkingCopyAsCopy = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/optimized.pdf',
            saveMode: 'save_as_rewrite' as const,
            didSaveAs: true,
        }));
        const {deps} = createDeps({optimizeWorkingCopyAsCopy});
        const {handleOptimizePdfAsCopy} = useWorkspaceSaveServiceForTest(deps);

        await expect(handleOptimizePdfAsCopy(
            {preset: 'lossless'},
            'optimize-1',
        )).resolves.toBe(true);

        expect(optimizeWorkingCopyAsCopy).toHaveBeenCalledWith(
            {preset: 'lossless'},
            'optimize-1',
            {
                saveMode: 'save_as_rewrite',
                expectedWorkingPath: '/tmp/work.pdf',
                expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-1'),
            },
        );
    });

    it('keeps edits made during optimization persistence dirty', async () => {
        let annotationToken = 'annotation-before';
        const optimizeWorkingCopyAsCopy = vi.fn(async () => {
            annotationToken = 'annotation-after-newer-edit';
            return {
                success: true,
                outPath: '/tmp/optimized.pdf',
                saveMode: 'save_as_rewrite' as const,
                didSaveAs: true,
            };
        });
        const {deps} = createDeps({
            optimizeWorkingCopyAsCopy,
            getAnnotationSaveStateToken: () => annotationToken,
        });
        const {handleOptimizePdfAsCopy} = useWorkspaceSaveServiceForTest(deps);

        await expect(handleOptimizePdfAsCopy(
            {preset: 'lossless'},
            'optimize-1',
        )).resolves.toBe(true);

        expect(optimizeWorkingCopyAsCopy).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
    });

});
