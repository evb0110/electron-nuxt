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
});
