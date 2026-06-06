import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    ensureWorkingCopyDirectory: vi.fn(async () => true),
    existsSync: vi.fn(() => true),
    exportPdfAsMultiPageTiff: vi.fn(),
    exportPdfPagesAsImages: vi.fn(),
    fromWebContents: vi.fn(() => null),
    normalizeImageExportPath: vi.fn((path: string) => ({ normalizedPath: path })),
    resolveAllowedWritePath: vi.fn(async (path: string) => path),
    showSaveDialog: vi.fn(async () => ({
        canceled: false,
        filePath: '/tmp/export.png',
    })),
}));

vi.mock('electron', () => ({
    BrowserWindow: { fromWebContents: mocks.fromWebContents },
    dialog: { showSaveDialog: mocks.showSaveDialog },
}));

vi.mock('fs', () => ({ existsSync: mocks.existsSync }));

vi.mock('@electron/ipc/workingCopyCreation', () => ({ ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory }));

vi.mock('@electron/utils/pathValidator', () => ({ resolveAllowedWritePath: mocks.resolveAllowedWritePath }));

vi.mock('@electron/features/image-export/main/export', () => ({
    exportPdfAsMultiPageTiff: mocks.exportPdfAsMultiPageTiff,
    exportPdfPagesAsImages: mocks.exportPdfPagesAsImages,
    normalizeImageExportPath: mocks.normalizeImageExportPath,
}));

vi.mock('@electron/te', () => ({ te: (key: string) => key }));

const {
    handlePdfExportImages,
    handlePdfExportMultiPageTiff,
} = await import('@electron/features/image-export/main/ipc');

interface ITestSender {
    id: number;
    destroyed: boolean;
    isDestroyed: () => boolean;
    once: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
}

function createSender(): ITestSender {
    const sender: ITestSender = {
        id: 7,
        destroyed: false,
        isDestroyed: () => sender.destroyed,
        once: vi.fn(),
        removeListener: vi.fn(),
    };
    return sender;
}

function triggerRenderProcessGone(sender: ITestSender) {
    const handler = sender.once.mock.calls
        .find(call => call[0] === 'render-process-gone')?.[1] as (() => void) | undefined;
    handler?.();
}

describe('image export IPC lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.existsSync.mockReturnValue(true);
        mocks.resolveAllowedWritePath.mockImplementation(async (path: string) => path);
        mocks.showSaveDialog.mockResolvedValue({
            canceled: false,
            filePath: '/tmp/export.png',
        });
        mocks.normalizeImageExportPath.mockImplementation((path: string) => ({ normalizedPath: path }));
    });

    it('aborts page image export when the owning renderer crashes', async () => {
        const sender = createSender();
        const exportState: {signal: AbortSignal | undefined} = { signal: undefined };
        mocks.exportPdfPagesAsImages.mockImplementation(async (
            _sourcePath: string,
            _outputPath: string,
            options: { signal?: AbortSignal },
        ) => {
            exportState.signal = options.signal;
            return new Promise<string[]>((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    reject(new Error('Renderer lifecycle ended'));
                }, { once: true });
            });
        });

        const resultPromise = handlePdfExportImages(
            { sender } as never,
            '/tmp/working.pdf',
            [1],
        );

        await vi.waitFor(() => {
            expect(mocks.exportPdfPagesAsImages).toHaveBeenCalledOnce();
        });
        triggerRenderProcessGone(sender);

        await expect(resultPromise).resolves.toEqual({
            success: false,
            canceled: true,
        });
        expect(exportState.signal?.aborted).toBe(true);
        expect(sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(sender.removeListener).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    });

    it('passes renderer lifecycle cancellation to multi-page TIFF export', async () => {
        const sender = createSender();
        const exportState: {signal: AbortSignal | undefined} = { signal: undefined };
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/export.tiff',
        });
        mocks.exportPdfAsMultiPageTiff.mockImplementation(async (
            _sourcePath: string,
            outputPath: string,
            options: { signal?: AbortSignal },
        ) => {
            exportState.signal = options.signal;
            return outputPath;
        });

        await expect(handlePdfExportMultiPageTiff(
            { sender } as never,
            '/tmp/working.pdf',
        )).resolves.toEqual({
            success: true,
            outputPath: '/tmp/export.tiff',
        });

        expect(exportState.signal).toBeInstanceOf(AbortSignal);
        expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(sender.once).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    });
});
