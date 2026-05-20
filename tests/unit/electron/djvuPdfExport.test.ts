import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TOpenPath } from '@electron/ipc/openPathCapabilities';

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
        rename: vi.fn(),
        rm: vi.fn(),
        stat: vi.fn(),
        unlink: vi.fn(),
        atomicReplace: vi.fn(),
        getDjvuPageCount: vi.fn(),
        getDjvuOutline: vi.fn(),
        parseDjvuOutline: vi.fn(),
        convertDjvuToPdfFile: vi.fn(),
        cancelConversion: vi.fn(),
        embedBookmarksIntoPdfFile: vi.fn(),
        createDjvuPdfBookmarkTask: vi.fn(),
        consumeAllowedDjvuWritePath: vi.fn(),
        safeSendToWindow: vi.fn(),
        loggerInfo: vi.fn(),
        loggerWarn: vi.fn(),
        loggerError: vi.fn(),
    };
});

vi.mock('electron', () => ({ BrowserWindow: {fromWebContents: mocks.browserWindowFromWebContents} }));

vi.mock('node:crypto', () => ({randomUUID: mocks.randomUUID}));

vi.mock('fs/promises', () => ({
    rename: mocks.rename,
    rm: mocks.rm,
    stat: mocks.stat,
    unlink: mocks.unlink,
}));

vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({
    cancelConversion: mocks.cancelConversion,
    convertDjvuToPdfFile: mocks.convertDjvuToPdfFile,
}));

vi.mock('@electron/djvu/metadata', () => ({
    getDjvuOutline: mocks.getDjvuOutline,
    getDjvuPageCount: mocks.getDjvuPageCount,
}));

vi.mock('@electron/djvu/bookmarks', () => ({parseDjvuOutline: mocks.parseDjvuOutline}));
vi.mock('@electron/djvu/pdfBookmarks', () => ({embedBookmarksIntoPdfFile: mocks.embedBookmarksIntoPdfFile}));
vi.mock('@electron/djvu/exportPaths', () => ({consumeAllowedDjvuWritePath: mocks.consumeAllowedDjvuWritePath}));
vi.mock('@electron/djvu/ipcShared', () => ({safeSendToWindow: mocks.safeSendToWindow}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: vi.fn(),
})}));

vi.mock('@electron/utils/atomicReplace', () => ({atomicReplace: mocks.atomicReplace}));

vi.mock('@electron/features/djvu/main/pdfWorkerClient', () => ({
    createDjvuPdfBookmarkTask: mocks.createDjvuPdfBookmarkTask,
    DjvuPdfWorkerStartupError: mocks.StartupError,
}));

const {
    handleDjvuCancel,
    handleDjvuConvertToPdf,
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

describe('handleDjvuConvertToPdf', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.bookmarkTaskState.mode = 'success';
        mocks.bookmarkTaskState.rejectPendingBookmark = null;
        mocks.bookmarkTaskState.workerTerminate = vi.fn(() => {
            mocks.bookmarkTaskState.rejectPendingBookmark?.(new Error('worker terminated'));
            return Promise.resolve(0);
        });

        mocks.randomUUID
            .mockReturnValueOnce('convert-123')
            .mockReturnValue('temp-456');
        mocks.rename.mockResolvedValue(undefined);
        mocks.rm.mockResolvedValue(undefined);
        mocks.stat.mockResolvedValue({size: 8 * 1024 * 1024});
        mocks.unlink.mockResolvedValue(undefined);
        mocks.atomicReplace.mockResolvedValue(undefined);
        mocks.getDjvuPageCount.mockResolvedValue(2);
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
        mocks.cancelConversion.mockReturnValue(false);
        mocks.embedBookmarksIntoPdfFile.mockResolvedValue(123);
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
            createEvent(7) as never,
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
        expect(mocks.createDjvuPdfBookmarkTask).toHaveBeenCalledTimes(1);
        expect(mocks.embedBookmarksIntoPdfFile).toHaveBeenCalledTimes(1);
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('rejects large bookmark fallback when the worker is unavailable', async () => {
        mocks.bookmarkTaskState.mode = 'startup-error';
        mocks.stat.mockResolvedValue({size: 256 * 1024 * 1024});

        const result = await handleDjvuConvertToPdf(
            createEvent(7) as never,
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

    it('terminates the active bookmark worker when cancel is requested', async () => {
        mocks.bookmarkTaskState.mode = 'cancel-pending';

        const convertPromise = handleDjvuConvertToPdf(
            createEvent(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        for (let attempt = 0; attempt < 50 && mocks.createDjvuPdfBookmarkTask.mock.calls.length === 0; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        expect(mocks.createDjvuPdfBookmarkTask).toHaveBeenCalledTimes(1);
        const cancelResult = await handleDjvuCancel(
            createEvent(7) as never,
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
            createEvent(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        for (let attempt = 0; attempt < 5 && mocks.getDjvuPageCount.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        const metadataOptions = mocks.getDjvuPageCount.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
        const cancelResult = await handleDjvuCancel(
            createEvent(7) as never,
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

    it('atomically replaces the output file', async () => {
        const result = await handleDjvuConvertToPdf(
            createEvent(7) as never,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: false},
        );

        expect(result).toEqual({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: 'djvu-convert-convert-123',
        });
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/.convert-123.convert.pdf', '/tmp/output.pdf');
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
        const event = createEvent(9);

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
        const firstEvent = createEvent(10);
        const queuedEvent = createEvent(11);

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
