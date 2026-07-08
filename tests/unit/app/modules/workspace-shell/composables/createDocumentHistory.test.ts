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

function createHistoryHarness() {
    const state = createDocumentSessionState({ isDesktopRuntime: ref(false) });
    state.workingCopyPath.value = '/tmp/work.pdf';
    state.originalPath.value = '/tmp/original.pdf';
    state.documentRevisionToken.value = 'revision-before-restore';

    const documentFiles = {writeFile: vi.fn(async () => true)};
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
            { expectedDocumentRevisionToken: 'revision-before-restore' },
        );
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
            expectedRevision: 'revision-before-restore',
            actualRevision: 'revision-after-edit',
        }));

        await expect(history.undo()).rejects.toMatchObject({ code: 'STALE_REVISION' });
        expect(history.getHistoryDebugState().historyIndex).toBe(1);
        expect(documentFiles.writeFile).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            new Uint8Array([1]),
            { expectedDocumentRevisionToken: 'revision-before-restore' },
        );
    });

    it('restores path-backed external mutations to the clean baseline on undo', async () => {
        const state = createDocumentSessionState({ isDesktopRuntime: ref(true) });
        state.workingCopyPath.value = '/tmp/work.pdf';
        state.originalPath.value = '/tmp/original.pdf';
        state.documentRevisionToken.value = 'revision-before-restore';

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
            documentFiles: () => ({writeFile: vi.fn(async () => true)}),
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
});
