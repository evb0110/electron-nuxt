import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

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
            mode: 'success' as 'cancel-pending' | 'startup-error' | 'success',
            workerTerminate: vi.fn(() => Promise.resolve(0)),
            rejectPendingBookmark: null as ((error: Error) => void) | null,
        },
        browserWindowFromWebContents: vi.fn(() => null),
        randomUUID: vi.fn(),
        rename: vi.fn(),
        rm: vi.fn(),
        stat: vi.fn(),
        unlink: vi.fn(),
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

vi.mock('@electron/features/djvu/main/ddjvu-conversion', () => ({
    cancelConversion: mocks.cancelConversion,
    convertDjvuToPdfFile: mocks.convertDjvuToPdfFile,
}));

vi.mock('@electron/djvu/metadata', () => ({
    getDjvuOutline: mocks.getDjvuOutline,
    getDjvuPageCount: mocks.getDjvuPageCount,
}));

vi.mock('@electron/djvu/bookmarks', () => ({parseDjvuOutline: mocks.parseDjvuOutline}));
vi.mock('@electron/djvu/pdf-bookmarks', () => ({embedBookmarksIntoPdfFile: mocks.embedBookmarksIntoPdfFile}));
vi.mock('@electron/djvu/export-paths', () => ({consumeAllowedDjvuWritePath: mocks.consumeAllowedDjvuWritePath}));
vi.mock('@electron/djvu/ipc-shared', () => ({safeSendToWindow: mocks.safeSendToWindow}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: vi.fn(),
})}));

vi.mock('@electron/features/djvu/main/pdf-worker-client', () => ({
    createDjvuPdfBookmarkTask: mocks.createDjvuPdfBookmarkTask,
    DjvuPdfWorkerStartupError: mocks.StartupError,
}));

const {
    handleDjvuCancel,
    handleDjvuConvertToPdf,
} = await import('@electron/features/djvu/main/pdf-export');

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

    it('falls back to in-process bookmark embedding only for small PDFs when worker startup fails', async () => {
        mocks.bookmarkTaskState.mode = 'startup-error';

        const result = await handleDjvuConvertToPdf(
            {sender: {id: 7}} as never,
            '/tmp/input.djvu',
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        expect(result).toEqual({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: 'djvu-convert-convert-123',
        });
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledTimes(1);
        expect(mocks.createDjvuPdfBookmarkTask).toHaveBeenCalledTimes(1);
        expect(mocks.embedBookmarksIntoPdfFile).toHaveBeenCalledTimes(1);
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('rejects large bookmark fallback when the worker is unavailable', async () => {
        mocks.bookmarkTaskState.mode = 'startup-error';
        mocks.stat.mockResolvedValue({size: 256 * 1024 * 1024});

        const result = await handleDjvuConvertToPdf(
            {sender: {id: 7}} as never,
            '/tmp/input.djvu',
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
            {sender: {id: 7}} as never,
            '/tmp/input.djvu',
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        for (let attempt = 0; attempt < 5 && mocks.createDjvuPdfBookmarkTask.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        await Promise.resolve();
        const cancelResult = handleDjvuCancel(
            {sender: {id: 7}} as never,
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

    it('replaces an existing output file when Windows rename refuses overwrite', async () => {
        mocks.rename
            .mockRejectedValueOnce(Object.assign(new Error('target exists'), { code: 'EEXIST' }))
            .mockResolvedValue(undefined);

        const result = await handleDjvuConvertToPdf(
            {sender: {id: 7}} as never,
            '/tmp/input.djvu',
            '/tmp/output.pdf',
            {preserveBookmarks: false},
        );

        expect(result).toEqual({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: 'djvu-convert-convert-123',
        });
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/output.pdf');
        expect(mocks.rename).toHaveBeenCalledTimes(2);
    });
});
