import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import {
    createDocumentHistory,
    type IPdfLoadedState,
} from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import { createDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/createDocumentSessionState';
import {
    createMissingRevisionError,
    createStaleRevisionError,
} from '@contracts/documentMutationErrors';
import {requireDocumentRevisionToken} from '@contracts';

function createHistoryHarness(isDesktopRuntime = false) {
    const state = createDocumentSessionState({ isDesktopRuntime: ref(isDesktopRuntime) });
    state.workingCopyPath.value = '/tmp/work.pdf';
    state.originalPath.value = '/tmp/original.pdf';
    state.documentRevisionToken.value = requireDocumentRevisionToken('revision-before-restore');

    const documentFiles = {
        writeFile: vi.fn(async () => true),
        getDocumentRevision: vi.fn(async () => ({
            version: 1 as const,
            documentRef: '/tmp/history.pdf',
            token: requireDocumentRevisionToken('history-revision'),
            contentRevision: 1,
            authority: 'electron-working-copy' as const,
            mintedAt: 1,
        })),
        savePdfData: vi.fn(async () => ({
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        })),
    };
    const documentWorkingCopy = {
        cleanupFile: vi.fn(async () => undefined),
        createWorkingCopyFromData: vi.fn(async () => '/tmp/history.pdf'),
        createWorkingCopyFromPath: vi.fn(async () => '/tmp/history.pdf'),
    };

    const history = createDocumentHistory(state, {
        applyLoadedPdfState: vi.fn(async () => undefined),
        clearPdfConformanceProfile: vi.fn(),
        clearOcrCache: vi.fn(),
        deferPdfConformanceProfile: vi.fn(),
        documentFiles: () => documentFiles,
        documentWorkingCopy: () => documentWorkingCopy,
        getOpenEpoch: () => 1,
        isCurrentOpenEpoch: () => true,
        readPdfStateFromPath: vi.fn(async (): Promise<IPdfLoadedState> => ({
            pdfData: new Uint8Array([3]),
            pdfSrc: {
                kind: 'path',
                path: '/tmp/history.pdf',
                size: 1,
            },
        })),
        toPdfBlob: vi.fn(() => new Blob()),
    });

    return {
        documentFiles,
        documentWorkingCopy,
        history,
        state,
    };
}

describe('createDocumentHistory', () => {
    it('keeps document open viable when an oversized baseline cannot be staged', async () => {
        const {
            documentWorkingCopy,
            history,
        } = createHistoryHarness(true);
        documentWorkingCopy.createWorkingCopyFromPath.mockRejectedValueOnce(new Error('staging failed'));

        await expect(history.resetHistory(
            new Uint8Array((16 * 1024 * 1024) + 1),
            { reuseSnapshot: true },
        )).resolves.toBe(true);

        expect(history.getHistoryDebugState()).toEqual({
            historyLength: 0,
            historyIndex: 0,
            historyCleanIndex: -1,
        });
    });

    it('rejects oversized byte entries supplied through the public history entry API', () => {
        const {history} = createHistoryHarness();

        expect(history.pushHistoryEntry({
            kind: 'bytes',
            snapshot: new Uint8Array((16 * 1024 * 1024) + 1),
        })).toBe(false);
        expect(history.getHistoryDebugState().historyLength).toBe(0);
    });

    it('publishes file checkpoints directly to the workspace command sink', async () => {
        const {history} = createHistoryHarness();
        const registrations: Array<{
            source: string;
            estimatedBytes?: number;
            undo: () => Promise<boolean>;
            cmd: () => Promise<boolean>;
        }> = [];
        const reset = vi.fn();
        history.setWorkspaceCommandSink({
            register: command => registrations.push(command as typeof registrations[number]),
            reset,
        });
        await history.resetHistory(new Uint8Array([1]), {reuseSnapshot: true});
        await history.pushHistorySnapshot(new Uint8Array([
            2,
            3,
        ]), {reuseSnapshot: true});

        expect(registrations).toHaveLength(1);
        expect(registrations[0]).toMatchObject({
            source: 'file',
            estimatedBytes: 2,
        });
        await expect(registrations[0]?.undo()).resolves.toBe(true);
        await expect(registrations[0]?.cmd()).resolves.toBe(true);

        history.incrementSessionVersion();
        expect(reset).toHaveBeenCalledWith();
    });

    it('keeps the undo cursor unchanged when restoring bytes fails', async () => {
        const {
            documentFiles,
            history,
        } = createHistoryHarness();

        await history.resetHistory(new Uint8Array([1]), { reuseSnapshot: true });
        await history.pushHistorySnapshot(new Uint8Array([2]), { reuseSnapshot: true });
        expect(history.getHistoryDebugState().historyIndex).toBe(1);

        documentFiles.writeFile.mockRejectedValueOnce(new Error('write failed'));

        await expect(history.undo()).rejects.toThrow('write failed');
        expect(history.getHistoryDebugState().historyIndex).toBe(1);
    });

    it('restores byte history with the current document revision token', async () => {
        const {
            documentFiles,
            history,
        } = createHistoryHarness();

        await history.resetHistory(new Uint8Array([1]), { reuseSnapshot: true });
        await history.pushHistorySnapshot(new Uint8Array([2]), { reuseSnapshot: true });

        await expect(history.undo()).resolves.toBe(true);

        expect(documentFiles.writeFile).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            new Uint8Array([1]),
            { expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-restore') },
        );
    });

    it('restores byte-identical checkpoints through an undo and redo round trip', async () => {
        const {
            documentFiles,
            history,
            state,
        } = createHistoryHarness();
        const before = new Uint8Array([
            37,
            80,
            68,
            70,
            45,
            49,
            46,
            55,
            10,
            1,
            2,
            3,
        ]);
        const after = new Uint8Array([
            37,
            80,
            68,
            70,
            45,
            49,
            46,
            55,
            10,
            9,
            8,
            7,
        ]);
        await history.resetHistory(before, {reuseSnapshot: true});
        await history.pushHistorySnapshot(after, {reuseSnapshot: true});

        await expect(history.undo()).resolves.toBe(true);
        expect(documentFiles.writeFile).toHaveBeenLastCalledWith(
            '/tmp/work.pdf',
            before,
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-restore')},
        );
        expect(state.pdfData.value).toEqual(before);

        await expect(history.redo()).resolves.toBe(true);
        expect(documentFiles.writeFile).toHaveBeenLastCalledWith(
            '/tmp/work.pdf',
            after,
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-restore')},
        );
        expect(state.pdfData.value).toEqual(after);
    });

    it('propagates missing revision rejection when byte history restore has no token', async () => {
        const {
            documentFiles,
            history,
            state,
        } = createHistoryHarness();
        state.documentRevisionToken.value = null;

        await history.resetHistory(new Uint8Array([1]), { reuseSnapshot: true });
        await history.pushHistorySnapshot(new Uint8Array([2]), { reuseSnapshot: true });
        documentFiles.writeFile.mockRejectedValueOnce(createMissingRevisionError({ documentRef: '/tmp/work.pdf' }));

        await expect(history.undo()).rejects.toMatchObject({ code: 'MISSING_REVISION' });
        expect(history.getHistoryDebugState().historyIndex).toBe(1);
        expect(documentFiles.writeFile).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            new Uint8Array([1]),
            undefined,
        );
    });

    it('propagates stale revision rejection when byte history restore uses an old token', async () => {
        const {
            documentFiles,
            history,
        } = createHistoryHarness();

        await history.resetHistory(new Uint8Array([1]), { reuseSnapshot: true });
        await history.pushHistorySnapshot(new Uint8Array([2]), { reuseSnapshot: true });
        documentFiles.writeFile.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: '/tmp/work.pdf',
            expectedRevision: requireDocumentRevisionToken('revision-before-restore'),
            actualRevision: requireDocumentRevisionToken('revision-after-edit'),
        }));

        await expect(history.undo()).rejects.toMatchObject({ code: 'STALE_REVISION' });
        expect(history.getHistoryDebugState().historyIndex).toBe(1);
        expect(documentFiles.writeFile).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            new Uint8Array([1]),
            { expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-restore') },
        );
    });

    it('restores path-backed external mutations to the clean baseline on undo', async () => {
        const state = createDocumentSessionState({ isDesktopRuntime: ref(true) });
        state.workingCopyPath.value = '/tmp/work.pdf';
        state.originalPath.value = '/tmp/original.pdf';
        state.documentRevisionToken.value = requireDocumentRevisionToken('revision-before-restore');

        const createWorkingCopyFromPath = vi.fn()
            .mockResolvedValueOnce('/tmp/history-baseline.pdf')
            .mockResolvedValueOnce('/tmp/history-ocr.pdf')
            .mockResolvedValueOnce('/tmp/restored-work.pdf');
        const readPdfStateFromPath = vi.fn(async (path: string): Promise<IPdfLoadedState> => ({
            pdfData: null,
            pdfSrc: {
                kind: 'path',
                path,
                size: 64 * 1024 * 1024,
            },
        }));
        const applyLoadedPdfState = vi.fn(async () => true);
        const history = createDocumentHistory(state, {
            applyLoadedPdfState,
            clearPdfConformanceProfile: vi.fn(),
            clearOcrCache: vi.fn(),
            deferPdfConformanceProfile: vi.fn(),
            documentFiles: () => ({
                writeFile: vi.fn(async () => true),
                getDocumentRevision: vi.fn(async () => ({
                    version: 1 as const,
                    documentRef: '/tmp/history.pdf',
                    token: requireDocumentRevisionToken('history-revision'),
                    contentRevision: 1,
                    authority: 'electron-working-copy' as const,
                    mintedAt: 1,
                })),
                savePdfData: vi.fn(async () => ({
                    isValid: true,
                    tool: 'qpdf' as const,
                    errors: [],
                    warnings: [],
                })),
            }),
            documentWorkingCopy: () => ({
                cleanupFile: vi.fn(async () => undefined),
                createWorkingCopyFromData: vi.fn(async () => '/tmp/unused-data-history.pdf'),
                createWorkingCopyFromPath,
            }),
            getOpenEpoch: () => 1,
            isCurrentOpenEpoch: () => true,
            readPdfStateFromPath,
            toPdfBlob: vi.fn(() => new Blob()),
        });

        await expect(history.ensureHistoryBaselineForExternalMutation()).resolves.toBe(true);
        await expect(history.reloadWorkingCopyIntoHistory({markDirty: true})).resolves.toBe(true);

        expect(history.canUndo.value).toBe(true);
        expect(state.isDirty.value).toBe(true);
        expect(history.getHistoryDebugState()).toMatchObject({
            historyLength: 2,
            historyIndex: 1,
            historyCleanIndex: 0,
        });

        await expect(history.undo()).resolves.toBe(true);

        expect(state.isDirty.value).toBe(false);
        expect(history.getHistoryDebugState()).toMatchObject({
            historyLength: 2,
            historyIndex: 0,
            historyCleanIndex: 0,
        });
        expect(createWorkingCopyFromPath).toHaveBeenNthCalledWith(
            1,
            '/tmp/work.pdf',
            '/tmp/original.pdf',
        );
        expect(createWorkingCopyFromPath).toHaveBeenNthCalledWith(
            3,
            '/tmp/history-baseline.pdf',
            '/tmp/original.pdf',
        );
        expect(applyLoadedPdfState).toHaveBeenCalledWith(
            '/tmp/restored-work.pdf',
            {
                pdfData: null,
                pdfSrc: {
                    kind: 'path',
                    path: '/tmp/restored-work.pdf',
                    size: 64 * 1024 * 1024,
                },
            },
            {
                preserveHistory: true,
                previousPath: '/tmp/work.pdf',
            },
        );
    });

    it('materializes a lazy clean baseline before the next external mutation without adding file undo', async () => {
        const {
            documentFiles,
            documentWorkingCopy,
            history,
            state,
        } = createHistoryHarness(true);
        const revision = requireDocumentRevisionToken('lazy-history-revision');
        state.documentRevisionToken.value = revision;
        documentFiles.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: '/tmp/work.pdf',
            token: revision,
            contentRevision: 2,
            authority: 'electron-working-copy',
            mintedAt: 2,
        });
        const register = vi.fn();
        history.setWorkspaceCommandSink({
            register,
            reset: vi.fn(),
        });
        await history.resetHistory(new Uint8Array([1]), {reuseSnapshot: true});
        await history.markCurrentHistoryEntryClean(null, {
            lazyBaseline: {
                workingPath: '/tmp/work.pdf',
                revision,
                size: 128,
            },
            recordSnapshotChange: false,
        });

        await expect(history.ensureHistoryBaselineForExternalMutation()).resolves.toBe(true);

        expect(documentFiles.getDocumentRevision).toHaveBeenCalledTimes(2);
        expect(documentWorkingCopy.createWorkingCopyFromPath).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/original.pdf',
        );
        expect(register).not.toHaveBeenCalled();
        expect(history.getHistoryDebugState()).toEqual({
            historyLength: 1,
            historyIndex: 0,
            historyCleanIndex: 0,
        });
    });

    it('refuses to materialize a lazy baseline after its working-copy revision changes', async () => {
        const {
            documentFiles,
            documentWorkingCopy,
            history,
            state,
        } = createHistoryHarness(true);
        const baselineRevision = requireDocumentRevisionToken('lazy-history-before');
        state.documentRevisionToken.value = baselineRevision;
        await history.markCurrentHistoryEntryClean(null, {
            lazyBaseline: {
                workingPath: '/tmp/work.pdf',
                revision: baselineRevision,
                size: 128,
            },
            recordSnapshotChange: false,
        });
        documentFiles.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: '/tmp/work.pdf',
            token: requireDocumentRevisionToken('lazy-history-after'),
            contentRevision: 3,
            authority: 'electron-working-copy',
            mintedAt: 3,
        });

        await expect(history.ensureHistoryBaselineForExternalMutation()).resolves.toBe(false);

        expect(documentWorkingCopy.createWorkingCopyFromPath).not.toHaveBeenCalled();
    });

    it('materializes a lazy redo snapshot before file undo moves the cursor', async () => {
        const {
            documentFiles,
            documentWorkingCopy,
            history,
            state,
        } = createHistoryHarness(true);
        const revision = requireDocumentRevisionToken('lazy-redo-revision');
        state.documentRevisionToken.value = revision;
        documentFiles.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: '/tmp/work.pdf',
            token: revision,
            contentRevision: 4,
            authority: 'electron-working-copy',
            mintedAt: 4,
        });
        await history.resetHistory(new Uint8Array([1]), {reuseSnapshot: true});
        await history.pushHistorySnapshot(new Uint8Array([2]), {reuseSnapshot: true});
        await history.markCurrentHistoryEntryClean(null, {
            lazyBaseline: {
                workingPath: '/tmp/work.pdf',
                revision,
                size: 256,
            },
            recordSnapshotChange: false,
        });

        await expect(history.undo()).resolves.toBe(true);

        expect(documentWorkingCopy.createWorkingCopyFromPath).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/original.pdf',
        );
        expect(documentWorkingCopy.createWorkingCopyFromPath.mock.invocationCallOrder[0])
            .toBeLessThan(documentFiles.writeFile.mock.invocationCallOrder[0]!);
        expect(history.canRedo.value).toBe(true);
    });
});
