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
const mockDocumentsCapability = {cleanupFile: cleanupFileMock};
const mockImageExportCapability = {
    exportPdfToImages: exportImagesMock,
    exportPdfToMultiPageTiff: exportTiffMock,
};

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentsCapability: () => mockDocumentsCapability,
    getImageExportCapability: () => mockImageExportCapability,
}));
vi.mock('@app/composables/useAnalytics', () => ({useAnalytics: () => ({track: trackMock})}));

function createComposable(options: {ensureWorkingCopyFreshForRead?: () => Promise<boolean>;} = {}) {
    const scope = effectScope();
    const state = scope.run(() => useWorkspaceExport({
        workingCopyPath: ref('/tmp/work.pdf'),
        totalPages: ref(5),
        ...(options.ensureWorkingCopyFreshForRead ? { ensureWorkingCopyFreshForRead: options.ensureWorkingCopyFreshForRead } : {}),
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
                    '/Users/test/Desktop/document-page-001.png',
                    '/Users/test/Desktop/document-page-002.png',
                    '/Users/test/Desktop/document-page-003.png',
                ],
            });
            await exportPromise;

            expect(cleanupFileMock).not.toHaveBeenCalled();
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

    it('cleans up browser output refs after image export', async () => {
        exportImagesMock.mockResolvedValueOnce({
            success: true,
            outputPaths: [
                'browser://documents/output/page-1.png',
                'browser://documents/output/page-2.png',
            ],
        });

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportImages([
                1,
                2,
            ]);
            state.handleExportScopeDialogSubmit({pageNumbers: [
                1,
                2,
            ]});
            await exportPromise;

            expect(cleanupFileMock).toHaveBeenCalledTimes(2);
            expect(cleanupFileMock).toHaveBeenCalledWith('browser://documents/output/page-1.png');
            expect(cleanupFileMock).toHaveBeenCalledWith('browser://documents/output/page-2.png');
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

    it('does not cleanup filesystem TIFF export outputs', async () => {
        exportTiffMock.mockResolvedValueOnce({
            success: true,
            outputPath: '/Users/test/Desktop/document-pages.tiff',
        });

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportMultiPageTiff([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await exportPromise;

            expect(cleanupFileMock).not.toHaveBeenCalled();
            expect(state.exportOverlay.value).toEqual({
                kind: 'multipage-tiff',
                pageCount: 1,
                state: 'success',
            });
        } finally {
            scope.stop();
        }
    });

    it('cleans up browser TIFF output refs', async () => {
        exportTiffMock.mockResolvedValueOnce({
            success: true,
            outputPath: 'browser://documents/output/document-pages.tiff',
        });

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportMultiPageTiff([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await exportPromise;

            expect(cleanupFileMock).toHaveBeenCalledOnce();
            expect(cleanupFileMock).toHaveBeenCalledWith('browser://documents/output/document-pages.tiff');
        } finally {
            scope.stop();
        }
    });

    it('persists pending changes before image export reads the working copy', async () => {
        const ensureWorkingCopyFreshForRead = vi.fn(async () => true);
        exportImagesMock.mockResolvedValueOnce({
            success: true,
            outputPaths: ['/tmp/page-1.png'],
        });

        const {
            scope,
            state,
        } = createComposable({ ensureWorkingCopyFreshForRead });

        try {
            const exportPromise = state.handleExportImages([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await exportPromise;

            expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
            expect(exportImagesMock).toHaveBeenCalledWith('/tmp/work.pdf', [1]);
        } finally {
            scope.stop();
        }
    });

    it('cancels image export when pending changes cannot be persisted', async () => {
        const ensureWorkingCopyFreshForRead = vi.fn(async () => false);

        const {
            scope,
            state,
        } = createComposable({ ensureWorkingCopyFreshForRead });

        try {
            const exportPromise = state.handleExportImages([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await exportPromise;

            expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
            expect(exportImagesMock).not.toHaveBeenCalled();
            expect(state.exportOverlay.value).toBeNull();
        } finally {
            scope.stop();
        }
    });
});
