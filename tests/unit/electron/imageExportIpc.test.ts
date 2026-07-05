import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';

const mocks = vi.hoisted(() => ({
    ensureWorkingCopyDirectory: vi.fn(async () => true),
    existsSync: vi.fn(() => true),
    exportPdfAsMultiPageTiff: vi.fn(),
    exportPdfPagesAsImages: vi.fn(),
    fromWebContents: vi.fn(() => null),
    getPdfPageCount: vi.fn(async () => 10),
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
    getPdfPageCount: mocks.getPdfPageCount,
    normalizeImageExportPath: mocks.normalizeImageExportPath,
}));

vi.mock('@electron/te', () => ({ te: (key: string) => key }));

const {
    handlePdfExportImages,
    handlePdfExportMultiPageTiff,
} = await import('@electron/features/image-export/main/ipc');
const { registerImageExportIpcAdapter } = await import('@electron/features/image-export/registerImageExportIpcAdapter');
const { IMAGE_EXPORT_CHANNELS } = await import('@electron/features/image-export/contract');

interface ITestSender {
    id: number;
    destroyed: boolean;
    isDestroyed: () => boolean;
    once: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
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
        on: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
    };
    return sender;
}

function createContext(sender: ITestSender) {
    return {
        sender: sender as never,
        senderId: sender.id,
        parentWindow: null,
    };
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

function createIpcEvent(sender: ITestSender) {
    return {sender: sender as never};
}

function triggerRenderProcessGone(sender: ITestSender) {
    const handler = sender.once.mock.calls
        .find(call => call[0] === 'render-process-gone')?.[1] as (() => void) | undefined;
    handler?.();
}

function triggerMainFrameNavigation(sender: ITestSender) {
    const handler = sender.on.mock.calls
        .find(call => call[0] === 'did-start-navigation')?.[1] as ((
            event: unknown,
            url: string,
            isInPlace: boolean,
            isMainFrame: boolean,
        ) => void) | undefined;
    handler?.({}, 'app://reload', false, true);
}

describe('image export IPC lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.existsSync.mockReturnValue(true);
        mocks.resolveAllowedWritePath.mockImplementation(async (path: string) => path);
        mocks.getPdfPageCount.mockResolvedValue(10);
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
            createContext(sender),
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
            createContext(sender),
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

    it('rejects malformed page number arrays before opening an image export dialog', async () => {
        const sender = createSender();

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
            [
                1,
                '2' as never,
            ],
        )).rejects.toThrow('Invalid page number at index 1');

        expect(mocks.showSaveDialog).not.toHaveBeenCalled();
        expect(mocks.exportPdfPagesAsImages).not.toHaveBeenCalled();
    });

    it('rejects duplicate page numbers before opening an image export dialog', async () => {
        const sender = createSender();

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
            [
                2,
                2,
            ],
        )).rejects.toThrow('Duplicate page number: 2');

        expect(mocks.showSaveDialog).not.toHaveBeenCalled();
        expect(mocks.exportPdfPagesAsImages).not.toHaveBeenCalled();
    });

    it('rejects page numbers beyond the PDF page count before opening an image export dialog', async () => {
        const sender = createSender();
        mocks.getPdfPageCount.mockResolvedValueOnce(3);

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
            [4],
        )).rejects.toThrow('Page number 4 exceeds PDF page count (3)');

        expect(mocks.showSaveDialog).not.toHaveBeenCalled();
        expect(mocks.exportPdfPagesAsImages).not.toHaveBeenCalled();
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
            createContext(sender),
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
        expect(sender.removeListener).toHaveBeenCalledWith('did-start-navigation', expect.any(Function));
    });

    it('cancels active image export when the renderer main frame navigates', async () => {
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
            createContext(sender),
            '/tmp/working.pdf',
            [1],
        );

        await vi.waitFor(() => {
            expect(mocks.exportPdfPagesAsImages).toHaveBeenCalledOnce();
        });
        triggerMainFrameNavigation(sender);

        await expect(resultPromise).resolves.toEqual({
            success: false,
            canceled: true,
        });
        expect(exportState.signal?.aborted).toBe(true);
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
            createContext(sender),
            '/tmp/working.pdf',
        )).resolves.toEqual({
            success: true,
            outputPath: '/tmp/export.tiff',
            outputPaths: ['/tmp/export.tiff'],
        });

        expect(exportState.signal).toBeInstanceOf(AbortSignal);
        expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(sender.once).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
        expect(sender.on).toHaveBeenCalledWith('did-start-navigation', expect.any(Function));
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
            createContext(sender),
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
            createContext(sender),
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

    it('replays active image-export progress when the renderer subscribes after progress starts', async () => {
        const handlers = new Map<string, TRegisteredHandler>();
        registerImageExportIpcAdapter({handle: (channel, handler) => handlers.set(channel, handler as TRegisteredHandler)});
        const sender = createSender();
        const exportDeferred = createDeferred<string[]>();
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
                processed: 3,
                total: 10,
                percent: 30,
            });
            return exportDeferred.promise.then(() => [outputPath]);
        });

        const exportPromise = handlers.get(IMAGE_EXPORT_CHANNELS.exportMultiPageTiff)!(
            createIpcEvent(sender),
            '/tmp/working.pdf',
            undefined,
            'export-subscribe-active',
        );
        await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith('pdfExport:progress', {
            requestId: 'export-subscribe-active',
            format: 'multipage-tiff',
            phase: 'rendering',
            processed: 3,
            total: 10,
            percent: 30,
        }));

        sender.send.mockClear();
        handlers.get(IMAGE_EXPORT_CHANNELS.subscribeProgress)!(createIpcEvent(sender));

        expect(sender.send).toHaveBeenCalledWith('pdfExport:progress', {
            requestId: 'export-subscribe-active',
            format: 'multipage-tiff',
            phase: 'rendering',
            processed: 3,
            total: 10,
            percent: 30,
        });
        exportDeferred.resolve(['/tmp/export.tiff']);
        await exportPromise;
    });

    it('replays terminal image-export progress when the renderer subscribes shortly after completion', async () => {
        const handlers = new Map<string, TRegisteredHandler>();
        registerImageExportIpcAdapter({handle: (channel, handler) => handlers.set(channel, handler as TRegisteredHandler)});
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
                phase: 'combining',
                processed: 10,
                total: 10,
                percent: 100,
            });
            return [outputPath];
        });

        await handlers.get(IMAGE_EXPORT_CHANNELS.exportMultiPageTiff)!(
            createIpcEvent(sender),
            '/tmp/working.pdf',
            undefined,
            'export-subscribe-terminal',
        );
        sender.send.mockClear();
        handlers.get(IMAGE_EXPORT_CHANNELS.subscribeProgress)!(createIpcEvent(sender));

        expect(sender.send).toHaveBeenCalledWith('pdfExport:progress', {
            requestId: 'export-subscribe-terminal',
            format: 'multipage-tiff',
            phase: 'combining',
            processed: 10,
            total: 10,
            percent: 100,
        });
    });

    it('rejects oversized image export progress request ids before opening a save dialog', async () => {
        const sender = createSender();
        const oversizedRequestId = 'x'.repeat(129);

        await expect(handlePdfExportMultiPageTiff(
            createContext(sender),
            '/tmp/working.pdf',
            undefined,
            oversizedRequestId,
        )).rejects.toThrow('requestId exceeds maximum length (128)');

        expect(mocks.showSaveDialog).not.toHaveBeenCalled();
        expect(mocks.ensureWorkingCopyDirectory).not.toHaveBeenCalled();
        expect(mocks.exportPdfAsMultiPageTiff).not.toHaveBeenCalled();
    });
});
