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

function createHistoryHarness() {
    const state = createDocumentSessionState({ isDesktopRuntime: ref(false) });
    state.workingCopyPath.value = '/tmp/work.pdf';
    state.originalPath.value = '/tmp/original.pdf';

    const documents = {
        cleanupFile: vi.fn(async () => undefined),
        createWorkingCopyFromData: vi.fn(async () => '/tmp/history.pdf'),
        createWorkingCopyFromPath: vi.fn(async () => '/tmp/history.pdf'),
        writeFile: vi.fn(async () => undefined),
    };

    const history = createDocumentHistory(state, {
        applyLoadedPdfState: vi.fn(async () => undefined),
        clearPdfConformanceProfile: vi.fn(),
        clearOcrCache: vi.fn(),
        deferPdfConformanceProfile: vi.fn(),
        documents: () => documents,
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
        documents,
        history,
        state,
    };
}

describe('createDocumentHistory', () => {
    it('keeps the undo cursor unchanged when restoring bytes fails', async () => {
        const {
            documents,
            history,
        } = createHistoryHarness();

        await history.resetHistory(new Uint8Array([1]), { reuseSnapshot: true });
        await history.pushHistorySnapshot(new Uint8Array([2]), { reuseSnapshot: true });
        expect(history.getHistoryDebugState().historyIndex).toBe(1);

        documents.writeFile.mockRejectedValueOnce(new Error('write failed'));

        await expect(history.undo()).rejects.toThrow('write failed');
        expect(history.getHistoryDebugState().historyIndex).toBe(1);
    });
});
