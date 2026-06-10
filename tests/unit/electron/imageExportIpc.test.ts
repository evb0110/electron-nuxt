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
    showSaveDialog: vi.fn(async (..._args: unknown[]) => ({
        canceled: false,
        filePath: '/tmp/export.jpg',
    })),
}));

vi.mock('electron', () => ({
    BrowserWindow: { fromWebContents: mocks.fromWebContents },
    dialog: { showSaveDialog: mocks.showSaveDialog },
}));

vi.mock('fs', () => ({ existsSync: mocks.existsSync }));

vi.mock('@electron/file-access/workingCopyCreation', () => ({ ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory }));

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
    send: ReturnType<typeof vi.fn>;
}

interface ITestProgressPayload {
    phase: 'rendering' | 'combining';
    processed: number;
    total: number;
    percent: number;
}

interface ITestProgressOptions { onProgress?: (progress: ITestProgressPayload) => void; }

function createSender(): ITestSender {
    const sender: ITestSender = {
        id: 7,
        destroyed: false,
        isDestroyed: () => sender.destroyed,
        once: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
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
            filePath: '/tmp/export.jpg',
        });
        mocks.normalizeImageExportPath.mockImplementation((
            path: string,
            fallbackFormat = 'png',
        ) => ({ normalizedPath: path.includes('.') ? path : `${path}.${fallbackFormat === 'jpeg' ? 'jpg' : fallbackFormat}` }));
        mocks.exportPdfPagesAsImages.mockResolvedValue(['/tmp/export.jpg']);
        mocks.exportPdfAsMultiPageTiff.mockResolvedValue(['/tmp/export.tiff']);
    });

    it('defaults page image export to JPEG while offering PNG and TIFF choices', async () => {
        const sender = createSender();

        await expect(handlePdfExportImages(
            { sender } as never,
            '/tmp/working.pdf',
            [7],
        )).resolves.toEqual({
            success: true,
            outputPaths: ['/tmp/export.jpg'],
        });

        const dialogOptions = mocks.showSaveDialog.mock.calls[0]?.[0];
        expect(dialogOptions).toEqual(expect.objectContaining({
            title: 'dialogs.exportImages',
            defaultPath: 'document-page-007.jpg',
            filters: [
                {
                    name: 'dialogs.jpegImages',
                    extensions: [
                        'jpg',
                        'jpeg',
                    ],
                },
                {
                    name: 'dialogs.pngImages',
                    extensions: ['png'],
                },
                {
                    name: 'dialogs.tiffImages',
                    extensions: [
                        'tif',
                        'tiff',
                    ],
                },
            ],
        }));
        expect(mocks.normalizeImageExportPath).toHaveBeenCalledWith('/tmp/export.jpg', 'jpeg');
    });

    it('uses a JPEG fallback when the image export target has no extension', async () => {
        const sender = createSender();
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/export',
        });
        mocks.exportPdfPagesAsImages.mockResolvedValueOnce(['/tmp/export.jpg']);

        await expect(handlePdfExportImages(
            { sender } as never,
            '/tmp/working.pdf',
        )).resolves.toEqual({
            success: true,
            outputPaths: ['/tmp/export.jpg'],
        });

        expect(mocks.normalizeImageExportPath).toHaveBeenCalledWith('/tmp/export', 'jpeg');
        expect(mocks.exportPdfPagesAsImages).toHaveBeenCalledWith(
            '/tmp/working.pdf',
            '/tmp/export.jpg',
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
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
            return [outputPath];
        });

        await expect(handlePdfExportMultiPageTiff(
            { sender } as never,
            '/tmp/working.pdf',
        )).resolves.toEqual({
            success: true,
            outputPath: '/tmp/export.tiff',
            outputPaths: ['/tmp/export.tiff'],
        });

        expect(exportState.signal).toBeInstanceOf(AbortSignal);
        expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(sender.once).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    });

    it('returns every split multi-page TIFF output path', async () => {
        const sender = createSender();
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/export.tiff',
        });
        mocks.exportPdfAsMultiPageTiff.mockResolvedValueOnce([
            '/tmp/export-part-001.tiff',
            '/tmp/export-part-002.tiff',
        ]);

        await expect(handlePdfExportMultiPageTiff(
            { sender } as never,
            '/tmp/working.pdf',
        )).resolves.toEqual({
            success: true,
            outputPath: '/tmp/export-part-001.tiff',
            outputPaths: [
                '/tmp/export-part-001.tiff',
                '/tmp/export-part-002.tiff',
            ],
        });
    });

    it('forwards multi-page TIFF progress to the requesting renderer', async () => {
        const sender = createSender();
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/export.tiff',
        });
        mocks.exportPdfAsMultiPageTiff.mockImplementationOnce(async (
            _sourcePath: string,
            outputPath: string,
            options: ITestProgressOptions,
        ) => {
            options.onProgress?.({
                phase: 'rendering',
                processed: 7,
                total: 10,
                percent: 63,
            });
            return [outputPath];
        });

        await expect(handlePdfExportMultiPageTiff(
            { sender } as never,
            '/tmp/working.pdf',
            undefined,
            'export-1',
        )).resolves.toEqual({
            success: true,
            outputPath: '/tmp/export.tiff',
            outputPaths: ['/tmp/export.tiff'],
        });

        expect(sender.send).toHaveBeenCalledWith('pdfExport:progress', {
            requestId: 'export-1',
            format: 'multipage-tiff',
            phase: 'rendering',
            processed: 7,
            total: 10,
            percent: 63,
        });
    });
});
