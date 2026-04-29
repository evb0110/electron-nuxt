import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import { useWorkspaceExport } from '@app/modules/workspace-shell/composables/useWorkspaceExport';

const trackMock = vi.hoisted(() => vi.fn());
const exportImagesMock = vi.hoisted(() => vi.fn());
const exportTiffMock = vi.hoisted(() => vi.fn());
const cleanupFileMock = vi.hoisted(() => vi.fn(async () => {}));
const mockDocumentsCapability = {
    exportPdfToImages: exportImagesMock,
    exportPdfToMultiPageTiff: exportTiffMock,
    cleanupFile: cleanupFileMock,
};

vi.mock('@app/utils/platform-documents', () => ({ getDocumentsCapability: () => mockDocumentsCapability }));
vi.mock('@app/composables/useAnalytics', () => ({useAnalytics: () => ({track: trackMock})}));

function createComposable() {
    const scope = effectScope();
    const state = scope.run(() => useWorkspaceExport({
        workingCopyPath: ref('/tmp/work.pdf'),
        totalPages: ref(5),
    }));

    if (!state) {
        throw new Error('Failed to create workspace export scope');
    }

    return {
        scope,
        state,
    };
}

describe('useWorkspaceExport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows a running export card and a temporary success state for image export', async () => {
        vi.useFakeTimers();
        const exportDeferred: { resolve?: (value: {
            success: boolean;
            outputPaths: string[];
        }) => void; } = {};
        exportImagesMock.mockImplementationOnce(() => new Promise((resolve) => {
            exportDeferred.resolve = resolve;
        }));

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportImages([
                1,
                2,
                3,
            ]);

            expect(state.exportScopeDialogOpen.value).toBe(true);
            state.handleExportScopeDialogSubmit({pageNumbers: [
                1,
                2,
                3,
            ]});
            await Promise.resolve();

            expect(state.exportOverlay.value).toEqual({
                kind: 'images',
                pageCount: 3,
                state: 'running',
            });

            const resolveExport = exportDeferred.resolve;
            if (!resolveExport) {
                throw new Error('Export promise resolver was not set');
            }

            resolveExport({
                success: true,
                outputPaths: [
                    '/tmp/page-1.png',
                    '/tmp/page-2.png',
                    '/tmp/page-3.png',
                ],
            });
            await exportPromise;

            expect(cleanupFileMock).toHaveBeenCalledTimes(3);
            expect(state.exportOverlay.value).toEqual({
                kind: 'images',
                pageCount: 3,
                state: 'success',
            });

            await vi.advanceTimersByTimeAsync(2200);
            expect(state.exportOverlay.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('clears the export card when TIFF export is canceled', async () => {
        exportTiffMock.mockResolvedValueOnce({
            success: false,
            canceled: true,
        });

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportMultiPageTiff([
                4,
                5,
            ]);

            expect(state.exportScopeDialogOpen.value).toBe(true);
            state.handleExportScopeDialogSubmit({pageNumbers: [
                4,
                5,
            ]});
            await exportPromise;

            expect(state.exportOverlay.value).toBeNull();
            expect(cleanupFileMock).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });
});
