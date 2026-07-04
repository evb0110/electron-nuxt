import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';

const mocks = vi.hoisted(() => {
    class MockDjvuPdfWorkerStartupError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'DjvuPdfWorkerStartupError';
        }
    }

    return {
        StartupError: MockDjvuPdfWorkerStartupError,
        bookmarkTaskState: {
            mode: 'success',
            workerTerminate: vi.fn(() => Promise.resolve(0)),
            rejectPendingBookmark: null as ((error: Error) => void) | null,
        },
        browserWindowFromWebContents: vi.fn(() => null),
        randomUUID: vi.fn(),
        copyFile: vi.fn(),
        makeSiblingTempPath: vi.fn(),
        mkdtemp: vi.fn(),
        readFile: vi.fn(),
        rename: vi.fn(),
        rm: vi.fn(),
        stat: vi.fn(),
        unlink: vi.fn(),
        writeFile: vi.fn(),
        atomicReplace: vi.fn(),
        getAppTempDir: vi.fn(),
        getDjvuPageCount: vi.fn(),
        getDjvuResolution: vi.fn(),
        getDjvuOutline: vi.fn(),
        getDjvuPageSizesForViewing: vi.fn(),
        parseDjvuOutline: vi.fn(),
        convertDjvuToPdfFile: vi.fn(),
        buildCompactDjvuAwarePdfFromDjvu: vi.fn(),
        cancelConversion: vi.fn(),
        embedBookmarksIntoPdfFile: vi.fn(),
        optimizeGeneratedPdfForInteraction: vi.fn(),
        printManagedTempPdfPath: vi.fn(),
        createDjvuPdfBookmarkTask: vi.fn(),
        consumeAllowedDjvuWritePath: vi.fn(),
        safeSendToWindow: vi.fn(),
        loggerInfo: vi.fn(),
        loggerWarn: vi.fn(),
        loggerError: vi.fn(),
    };
});

vi.mock('electron', () => ({
    app: {getPath: vi.fn(() => '/tmp')},
    BrowserWindow: {fromWebContents: mocks.browserWindowFromWebContents},
}));

vi.mock('node:crypto', () => ({randomUUID: mocks.randomUUID}));

vi.mock('fs/promises', () => ({
    copyFile: mocks.copyFile,
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rename: mocks.rename,
    rm: mocks.rm,
    stat: mocks.stat,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));

vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({
    cancelConversion: mocks.cancelConversion,
    convertDjvuToPdfFile: mocks.convertDjvuToPdfFile,
}));

vi.mock('@electron/features/djvu/main/buildCompactDjvuAwarePdfFromDjvu', () => ({buildCompactDjvuAwarePdfFromDjvu: mocks.buildCompactDjvuAwarePdfFromDjvu}));

vi.mock('@electron/djvu/metadata', () => ({
    getDjvuOutline: mocks.getDjvuOutline,
    getDjvuPageCount: mocks.getDjvuPageCount,
    getDjvuResolution: mocks.getDjvuResolution,
}));

vi.mock('@electron/features/djvu/main/pagePreview', () => ({getDjvuPageSizesForViewing: mocks.getDjvuPageSizesForViewing}));

vi.mock('@electron/djvu/parseDjvuOutline', () => ({parseDjvuOutline: mocks.parseDjvuOutline}));
vi.mock('@electron/djvu/embedBookmarksIntoPdfFile', () => ({embedBookmarksIntoPdfFile: mocks.embedBookmarksIntoPdfFile}));
vi.mock('@electron/features/documents/public/pdfSaveAsOptimization', () => ({optimizeGeneratedPdfForInteraction: (...args: unknown[]) => mocks.optimizeGeneratedPdfForInteraction(...args)}));
vi.mock('@electron/utils/printHandoff', () => ({
    PRINT_DJVU_TEMP_PREFIX: 'print-djvu-',
    printManagedTempPdfPath: (...args: unknown[]) => mocks.printManagedTempPdfPath(...args),
}));
vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: () => mocks.getAppTempDir()}));
vi.mock('@electron/djvu/exportPaths', () => ({consumeAllowedDjvuWritePath: mocks.consumeAllowedDjvuWritePath}));
vi.mock('@electron/djvu/safeSendToWindow', () => ({safeSendToWindow: mocks.safeSendToWindow}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: vi.fn(),
})}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: mocks.atomicReplace,
    makeSiblingTempPath: mocks.makeSiblingTempPath,
}));

vi.mock('@electron/features/djvu/main/pdfWorkerClient', () => ({
    createDjvuPdfBookmarkTask: mocks.createDjvuPdfBookmarkTask,
    DjvuPdfWorkerStartupError: mocks.StartupError,
}));

const {
    handleDjvuCancel,
    handleDjvuConvertToPdf,
    handleDjvuPrintPath,
    shutdownDjvuConversions,
} = await import('@electron/features/djvu/main/pdfExport');

const trustedDjvuPath = '/tmp/input.djvu' as TOpenPath;

function createEvent(senderId: number) {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const sender = {
        id: senderId,
        once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            const eventListeners = listeners.get(event) ?? [];
            eventListeners.push(listener);
            listeners.set(event, eventListeners);
            return sender;
        }),
        removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, (listeners.get(event) ?? []).filter(candidate => candidate !== listener));
            return sender;
        }),
        emit: (event: string, ...args: unknown[]) => {
            const eventListeners = listeners.get(event) ?? [];
            listeners.delete(event);
            for (const listener of eventListeners) {
                listener(...args);
            }
        },
    };
    return { sender };
}

function createOperationContext(senderId: number) {
    const event = createEvent(senderId);
    return {
        ...event,
        senderId,
        parentWindow: null,
    };
}

describe('handleDjvuConvertToPdf', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.randomUUID.mockReset();
        mocks.bookmarkTaskState.mode = 'success';
        mocks.bookmarkTaskState.rejectPendingBookmark = null;
        mocks.bookmarkTaskState.workerTerminate = vi.fn(() => {
            mocks.bookmarkTaskState.rejectPendingBookmark?.(new Error('worker terminated'));
            return Promise.resolve(0);
        });

        mocks.randomUUID
            .mockReturnValueOnce('convert-123')
            .mockReturnValue('temp-456');
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.makeSiblingTempPath.mockReturnValue('/tmp/.staged-output.tmp');
        mocks.mkdtemp.mockResolvedValue('/tmp/djvu-export-test');
        mocks.readFile.mockResolvedValue(Buffer.from('%PDF-1.7\n%%EOF\n'));
        mocks.rename.mockResolvedValue(undefined);
        mocks.rm.mockResolvedValue(undefined);
        mocks.stat.mockResolvedValue({size: 8 * 1024 * 1024});
        mocks.unlink.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.atomicReplace.mockResolvedValue(undefined);
        mocks.getAppTempDir.mockReturnValue('/tmp/evb-viewer');
        mocks.getDjvuPageCount.mockResolvedValue(2);
        mocks.getDjvuResolution.mockResolvedValue(300);
        mocks.getDjvuPageSizesForViewing.mockResolvedValue([
            {
                width: 1200,
                height: 1600,
                dpi: 300,
            },
            {
                width: 1200,
                height: 1600,
                dpi: 300,
            },
        ]);
        mocks.getDjvuOutline.mockResolvedValue('(bookmarks)');
        mocks.parseDjvuOutline.mockReturnValue([{
            title: 'Chapter 1',
            pageIndex: 0,
            items: [],
        }]);
        mocks.convertDjvuToPdfFile.mockImplementation(async (
            _djvuPath: string,
            _outputPath: string,
            _jobId: string,
            options?: { onProgress?: (percent: number) => void },
        ) => {
            options?.onProgress?.(90);
            return {success: true};
        });
        mocks.buildCompactDjvuAwarePdfFromDjvu.mockImplementation(async (options?: {onProgress?: (percent: number) => void;}) => {
            options?.onProgress?.(90);
            return {
                success: true,
                outputPath: '/tmp/djvu-export-test/convert-123.convert.pdf',
                fileSize: 1024,
            };
        });
        mocks.cancelConversion.mockReturnValue(false);
        mocks.embedBookmarksIntoPdfFile.mockResolvedValue(123);
        mocks.optimizeGeneratedPdfForInteraction.mockResolvedValue(null);
        mocks.printManagedTempPdfPath.mockResolvedValue({ success: true });
        mocks.createDjvuPdfBookmarkTask.mockImplementation(() => {
            if (mocks.bookmarkTaskState.mode === 'startup-error') {
                throw new mocks.StartupError('bookmark worker missing');
            }

            if (mocks.bookmarkTaskState.mode === 'cancel-pending') {
                const promise = new Promise<void>((_resolve, reject) => {
                    mocks.bookmarkTaskState.rejectPendingBookmark = reject;
                });
                return {
                    worker: { terminate: mocks.bookmarkTaskState.workerTerminate },
                    promise,
                };
            }

            return {
                worker: { terminate: vi.fn(() => Promise.resolve(0)) },
                promise: Promise.resolve(),
            };
        });
        mocks.consumeAllowedDjvuWritePath.mockImplementation((outputPath: string) => outputPath);
    });

    afterEach(async () => {
        await shutdownDjvuConversions();
    });

    it('falls back to in-process bookmark embedding only for small PDFs when worker startup fails', async () => {
        mocks.bookmarkTaskState.mode = 'startup-error';

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        expect(result).toEqual({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: 'djvu-convert-convert-123',
        });
        expect(mocks.getDjvuPageCount).toHaveBeenCalledWith(trustedDjvuPath, {signal: expect.any(AbortSignal)});
        expect(mocks.getDjvuOutline).toHaveBeenCalledWith(trustedDjvuPath, {signal: expect.any(AbortSignal)});
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledTimes(1);
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledWith(
            trustedDjvuPath,
            '/tmp/djvu-export-test/convert-123.convert.pdf',
            'djvu-convert-convert-123',
            expect.objectContaining({pageCount: 2}),
        );
        expect(mocks.createDjvuPdfBookmarkTask).toHaveBeenCalledTimes(1);
        expect(mocks.embedBookmarksIntoPdfFile).toHaveBeenCalledTimes(1);
        expect(mocks.optimizeGeneratedPdfForInteraction)
            .toHaveBeenCalledWith('/tmp/djvu-export-test/convert-123.bookmarks.pdf');
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('rejects large bookmark fallback when the worker is unavailable', async () => {
        mocks.bookmarkTaskState.mode = 'startup-error';
        mocks.stat.mockResolvedValue({size: 256 * 1024 * 1024});

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        expect(result).toEqual({
            success: false,
            jobId: 'djvu-convert-convert-123',
            error: 'DjVu bookmark embedding requires the PDF worker for files larger than 64MB',
        });
        expect(mocks.embedBookmarksIntoPdfFile).not.toHaveBeenCalled();
    });

    it('rejects unsafe full-resolution direct PDF conversion before spawning ddjvu', async () => {
        mocks.getDjvuPageCount.mockResolvedValue(564);
        mocks.getDjvuResolution.mockResolvedValue(600);
        mocks.getDjvuPageSizesForViewing.mockResolvedValue(Array.from({length: 564}, () => ({
            width: 5100,
            height: 6600,
            dpi: 600,
        })));

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {
                preserveBookmarks: true,
                subsample: 1,
            },
        );

        expect(result).toEqual({
            success: false,
            jobId: 'djvu-convert-convert-123',
            error: expect.stringContaining('Choose Good Quality or higher'),
        });
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        expect(mocks.getDjvuOutline).not.toHaveBeenCalled();
    });

    it('keeps explicit direct PDF strategy on the existing direct conversion path', async () => {
        const result = await handleDjvuConvertToPdf(
            createOperationContext(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {
                pdfStrategy: 'direct',
                preserveBookmarks: false,
                subsample: 2,
            },
        );

        expect(result).toEqual({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: 'djvu-convert-convert-123',
        });
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledWith(
            trustedDjvuPath,
            '/tmp/djvu-export-test/convert-123.convert.pdf',
            'djvu-convert-convert-123',
            expect.objectContaining({
                pageCount: 2,
                subsample: 2,
            }),
        );
        expect(mocks.createDjvuPdfBookmarkTask).not.toHaveBeenCalled();
    });

    it('resolves auto PDF strategy to the Stage A direct conversion path', async () => {
        const result = await handleDjvuConvertToPdf(
            createOperationContext(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {
                pdfStrategy: 'auto',
                preserveBookmarks: false,
            },
        );

        expect(result).toEqual({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: 'djvu-convert-convert-123',
        });
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledTimes(1);
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledWith(
            trustedDjvuPath,
            '/tmp/djvu-export-test/convert-123.convert.pdf',
            'djvu-convert-convert-123',
            expect.objectContaining({pageCount: 2}),
        );
    });

    it('uses the compact DjVu-aware builder only for the explicit compact strategy', async () => {
        const result = await handleDjvuConvertToPdf(
            createOperationContext(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {
                pdfStrategy: 'compact-djvu-aware',
                preserveBookmarks: false,
            },
        );

        expect(result).toEqual({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: 'djvu-convert-convert-123',
        });
        expect(mocks.getDjvuPageCount).toHaveBeenCalledWith(trustedDjvuPath, {signal: expect.any(AbortSignal)});
        expect(mocks.getDjvuResolution).toHaveBeenCalledWith(trustedDjvuPath, {signal: expect.any(AbortSignal)});
        expect(mocks.getDjvuPageSizesForViewing).toHaveBeenCalledWith(trustedDjvuPath, 2);
        expect(mocks.buildCompactDjvuAwarePdfFromDjvu).toHaveBeenCalledWith(expect.objectContaining({
            jobId: 'djvu-convert-convert-123',
            djvuPath: trustedDjvuPath,
            outputPath: '/tmp/djvu-export-test/convert-123.convert.pdf',
            tempDir: '/tmp/djvu-export-test',
            pageCount: 2,
            sourceDpi: 300,
            pageSizes: [
                {
                    width: 1200,
                    height: 1600,
                    dpi: 300,
                },
                {
                    width: 1200,
                    height: 1600,
                    dpi: 300,
                },
            ],
            signal: expect.any(AbortSignal),
            onProgress: expect.any(Function),
        }));
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        expect(mocks.getDjvuOutline).not.toHaveBeenCalled();
        expect(mocks.optimizeGeneratedPdfForInteraction)
            .toHaveBeenCalledWith('/tmp/djvu-export-test/convert-123.convert.pdf');
        expect(mocks.copyFile).toHaveBeenCalledWith(
            '/tmp/djvu-export-test/convert-123.convert.pdf',
            '/tmp/.staged-output.tmp',
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/.staged-output.tmp', '/tmp/output.pdf');
    });

    it('stops compact PDF export before finalization when the compact builder fails', async () => {
        mocks.buildCompactDjvuAwarePdfFromDjvu.mockResolvedValueOnce({
            success: false,
            outputPath: '/tmp/djvu-export-test/convert-123.convert.pdf',
            fileSize: 0,
            error: 'compact failed',
        });

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {
                pdfStrategy: 'compact-djvu-aware',
                preserveBookmarks: true,
            },
        );

        expect(result).toEqual({
            success: false,
            jobId: 'djvu-convert-convert-123',
            error: 'compact failed',
        });
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        expect(mocks.getDjvuOutline).not.toHaveBeenCalled();
        expect(mocks.optimizeGeneratedPdfForInteraction).not.toHaveBeenCalled();
        expect(mocks.copyFile).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
    });

    it('terminates the active bookmark worker when cancel is requested', async () => {
        mocks.bookmarkTaskState.mode = 'cancel-pending';

        const convertPromise = handleDjvuConvertToPdf(
            createOperationContext(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        for (let attempt = 0; attempt < 50 && mocks.createDjvuPdfBookmarkTask.mock.calls.length === 0; attempt += 1) {
            await delay(0);
        }
        expect(mocks.createDjvuPdfBookmarkTask).toHaveBeenCalledTimes(1);
        const cancelResult = await handleDjvuCancel(
            createOperationContext(7) as never,
            'djvu-convert-convert-123',
        );
        const result = await convertPromise;

        expect(cancelResult).toEqual({canceled: true});
        expect(mocks.bookmarkTaskState.workerTerminate).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            success: false,
            jobId: 'djvu-convert-convert-123',
            error: 'DjVu conversion canceled',
        });
    });

    it('aborts pending metadata commands when cancel is requested', async () => {
        mocks.getDjvuPageCount.mockImplementationOnce((
            _filePath: string,
            options?: { signal?: AbortSignal },
        ) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
                const error = new Error('DjVu conversion canceled');
                error.name = 'AbortError';
                reject(error);
            });
        }));

        const convertPromise = handleDjvuConvertToPdf(
            createOperationContext(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        for (let attempt = 0; attempt < 5 && mocks.getDjvuPageCount.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        const metadataOptions = mocks.getDjvuPageCount.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
        const cancelResult = await handleDjvuCancel(
            createOperationContext(7) as never,
            'djvu-convert-convert-123',
        );
        const result = await convertPromise;

        expect(cancelResult).toEqual({canceled: true});
        expect(metadataOptions?.signal?.aborted).toBe(true);
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        expect(result).toEqual({
            success: false,
            jobId: 'djvu-convert-convert-123',
            error: 'DjVu conversion canceled',
        });
    });

    it('emits initial progress immediately after registering the active job', async () => {
        mocks.getDjvuPageCount.mockImplementationOnce((
            _filePath: string,
            options?: { signal?: AbortSignal },
        ) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
                const error = new Error('DjVu conversion canceled');
                error.name = 'AbortError';
                reject(error);
            });
        }));

        const convertPromise = handleDjvuConvertToPdf(
            createOperationContext(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        await Promise.resolve();

        expect(mocks.safeSendToWindow).toHaveBeenCalledWith(null, 'djvu:progress', {
            jobId: 'djvu-convert-convert-123',
            phase: 'converting',
            percent: 0,
        });
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        for (let attempt = 0; attempt < 5 && mocks.getDjvuPageCount.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        expect(mocks.getDjvuPageCount).toHaveBeenCalledTimes(1);

        const cancelResult = await handleDjvuCancel(
            createOperationContext(7) as never,
            'djvu-convert-convert-123',
        );
        const result = await convertPromise;

        expect(cancelResult).toEqual({canceled: true});
        expect(result).toEqual({
            success: false,
            jobId: 'djvu-convert-convert-123',
            error: 'DjVu conversion canceled',
        });
    });

    it('atomically replaces the output file', async () => {
        const result = await handleDjvuConvertToPdf(
            createOperationContext(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: false},
        );

        expect(result).toEqual({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: 'djvu-convert-convert-123',
        });
        expect(mocks.copyFile).toHaveBeenCalledWith(
            '/tmp/djvu-export-test/convert-123.convert.pdf',
            '/tmp/.staged-output.tmp',
        );
        expect(mocks.optimizeGeneratedPdfForInteraction)
            .toHaveBeenCalledWith('/tmp/djvu-export-test/convert-123.convert.pdf');
        expect(
            mocks.optimizeGeneratedPdfForInteraction.mock.invocationCallOrder[0]!,
        ).toBeLessThan(mocks.copyFile.mock.invocationCallOrder[0]!);
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/.staged-output.tmp', '/tmp/output.pdf');
    });

    it('prints selected DjVu pages through compact temp PDF and native print handoff', async () => {
        const event = createOperationContext(12);

        const result = await handleDjvuPrintPath(
            event as never,
            trustedDjvuPath,
            {
                requestId: 'print-req',
                fileName: 'book.djvu',
                pageNumbers: [
                    2,
                    1,
                    2,
                ],
                viewMode: 'single',
                orientation: 'auto',
            },
        );

        const expectedFinalPath = '/tmp/evb-viewer/print-djvu-djvu-print-print-req.pdf';
        expect(result).toEqual({
            success: true,
            jobId: 'djvu-print-print-req',
        });
        expect(mocks.buildCompactDjvuAwarePdfFromDjvu).toHaveBeenCalledWith(expect.objectContaining({
            jobId: 'djvu-print-print-req',
            djvuPath: trustedDjvuPath,
            outputPath: expectedFinalPath,
            pages: [
                1,
                2,
            ],
        }));
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        expect(mocks.optimizeGeneratedPdfForInteraction).toHaveBeenCalledWith(expectedFinalPath);
        expect(mocks.safeSendToWindow).toHaveBeenCalledWith(null, 'djvu:progress', {
            jobId: 'djvu-print-print-req',
            phase: 'printing',
            percent: 100,
        });
        expect(mocks.printManagedTempPdfPath).toHaveBeenCalledWith(
            {window: null},
            expectedFinalPath,
            'book p1-2',
            {
                signal: expect.any(AbortSignal),
                surface: 'rasterized-html',
            },
        );
    });

    it('adds the selected DjVu page number to the native print save title', async () => {
        mocks.getDjvuPageCount.mockResolvedValueOnce(60);
        const event = createOperationContext(13);

        const result = await handleDjvuPrintPath(
            event as never,
            trustedDjvuPath,
            {
                requestId: 'print-page-50',
                fileName: 'book.djvu',
                pageNumbers: [50],
                viewMode: 'single',
                orientation: 'auto',
            },
        );

        expect(result).toEqual({
            success: true,
            jobId: 'djvu-print-print-page-50',
        });
        expect(mocks.buildCompactDjvuAwarePdfFromDjvu).toHaveBeenCalledWith(expect.objectContaining({pages: [50]}));
        expect(mocks.printManagedTempPdfPath).toHaveBeenCalledWith(
            {window: null},
            '/tmp/evb-viewer/print-djvu-djvu-print-print-page-50.pdf',
            'book p50',
            {
                signal: expect.any(AbortSignal),
                surface: 'rasterized-html',
            },
        );
    });

    it('aborts an active native DjVu print handoff when cancel is requested', async () => {
        let printSignal: AbortSignal | undefined;
        mocks.printManagedTempPdfPath.mockImplementationOnce((
            _context: unknown,
            _path: unknown,
            _fileName: unknown,
            options?: { signal?: AbortSignal },
        ) => {
            printSignal = options?.signal;
            return new Promise(resolve => {
                options?.signal?.addEventListener('abort', () => {
                    resolve({
                        success: false,
                        canceled: true,
                        error: 'Print handoff canceled',
                    });
                }, { once: true });
            });
        });
        const event = createOperationContext(14);

        const printPromise = handleDjvuPrintPath(
            event as never,
            trustedDjvuPath,
            {
                requestId: 'cancel-print',
                fileName: 'book.djvu',
                viewMode: 'single',
                orientation: 'auto',
            },
        );

        for (let attempt = 0; attempt < 20 && mocks.printManagedTempPdfPath.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        expect(mocks.printManagedTempPdfPath).toHaveBeenCalledTimes(1);

        const cancelResult = await handleDjvuCancel(
            event as never,
            'djvu-print-cancel-print',
        );
        const result = await printPromise;

        expect(cancelResult).toEqual({ canceled: true });
        expect(printSignal?.aborted).toBe(true);
        expect(result).toEqual({
            success: false,
            canceled: true,
            jobId: 'djvu-print-cancel-print',
            error: 'DjVu print preparation canceled',
        });
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('treats canceling DjVu print preparation as non-error logging', async () => {
        mocks.getDjvuPageCount.mockImplementationOnce((
            _filePath: string,
            options?: { signal?: AbortSignal },
        ) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
                reject(new Error('DjVu conversion canceled'));
            });
        }));
        const event = createOperationContext(15);

        const printPromise = handleDjvuPrintPath(
            event as never,
            trustedDjvuPath,
            {
                requestId: 'cancel-prep',
                fileName: 'book.djvu',
                viewMode: 'single',
                orientation: 'auto',
            },
        );

        for (let attempt = 0; attempt < 5 && mocks.getDjvuPageCount.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        const cancelResult = await handleDjvuCancel(
            event as never,
            'djvu-print-cancel-prep',
        );
        const result = await printPromise;

        expect(cancelResult).toEqual({ canceled: true });
        expect(result).toEqual({
            success: false,
            canceled: true,
            jobId: 'djvu-print-cancel-prep',
            error: 'DjVu print preparation canceled',
        });
        expect(mocks.loggerError).not.toHaveBeenCalled();
        expect(mocks.loggerInfo).toHaveBeenCalledWith(expect.stringContaining('DjVu print preparation canceled'));
    });

    it('cancels active jobs when the sender is destroyed', async () => {
        mocks.getDjvuPageCount.mockImplementationOnce((
            _filePath: string,
            options?: { signal?: AbortSignal },
        ) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
                const error = new Error('DjVu conversion canceled');
                error.name = 'AbortError';
                reject(error);
            });
        }));
        const event = createOperationContext(9);

        const convertPromise = handleDjvuConvertToPdf(
            event as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        for (let attempt = 0; attempt < 5 && mocks.getDjvuPageCount.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        const metadataOptions = mocks.getDjvuPageCount.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
        event.sender.emit('destroyed');
        const result = await convertPromise;

        expect(metadataOptions?.signal?.aborted).toBe(true);
        expect(result).toEqual({
            success: false,
            jobId: 'djvu-convert-convert-123',
            error: 'DjVu conversion canceled',
        });
        expect(event.sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(event.sender.removeListener).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    });

    it('removes queued jobs when their sender render process is gone', async () => {
        let finishFirstConversion!: () => void;
        mocks.convertDjvuToPdfFile.mockImplementationOnce(() => new Promise(resolve => {
            finishFirstConversion = () => {
                resolve({success: true});
            };
        }));
        const firstEvent = createOperationContext(10);
        const queuedEvent = createOperationContext(11);

        const firstPromise = handleDjvuConvertToPdf(
            firstEvent as never,
            trustedDjvuPath,
            '/tmp/first.pdf',
            {preserveBookmarks: false},
        );

        for (let attempt = 0; attempt < 10 && mocks.convertDjvuToPdfFile.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledTimes(1);

        const queuedPromise = handleDjvuConvertToPdf(
            queuedEvent as never,
            trustedDjvuPath,
            '/tmp/queued.pdf',
            {preserveBookmarks: false},
        );

        await Promise.resolve();
        queuedEvent.sender.emit('render-process-gone');
        await expect(queuedPromise).resolves.toEqual({
            success: false,
            jobId: 'djvu-convert-temp-456',
            error: 'DjVu conversion canceled',
        });
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledTimes(1);

        finishFirstConversion();
        await expect(firstPromise).resolves.toMatchObject({
            success: true,
            jobId: 'djvu-convert-convert-123',
        });
    });
});
