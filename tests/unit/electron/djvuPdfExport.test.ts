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

    const buildTaskState: {
        mode: 'cancel-pending' | 'startup-error' | 'success';
        workerTerminate: ReturnType<typeof vi.fn>;
        rejectPendingBuild: ((error: Error) => void) | null;
    } = {
        mode: 'success',
        workerTerminate: vi.fn(() => Promise.resolve(0)),
        rejectPendingBuild: null,
    };

    return {
        StartupError: MockDjvuPdfWorkerStartupError,
        buildTaskState,
        browserWindowFromWebContents: vi.fn(() => null),
        appGetPath: vi.fn(() => '/tmp'),
        randomUUID: vi.fn(),
        mkdir: vi.fn(),
        writeFile: vi.fn(),
        rename: vi.fn(),
        unlink: vi.fn(),
        rm: vi.fn(),
        getDjvuPageCount: vi.fn(),
        getDjvuResolution: vi.fn(),
        getDjvuOutline: vi.fn(),
        parseDjvuOutline: vi.fn(),
        convertAllPagesToImages: vi.fn(),
        cancelConversion: vi.fn(),
        buildOptimizedPdf: vi.fn(),
        embedBookmarksIntoPdf: vi.fn(),
        createDjvuPdfBuildTask: vi.fn(),
        createDjvuPdfBookmarkTask: vi.fn(),
        consumeAllowedDjvuWritePath: vi.fn(),
        safeSendToWindow: vi.fn(),
        loggerInfo: vi.fn(),
        loggerWarn: vi.fn(),
        loggerError: vi.fn(),
    };
});

vi.mock('electron', () => ({
    BrowserWindow: {fromWebContents: mocks.browserWindowFromWebContents},
    app: {getPath: mocks.appGetPath},
}));

vi.mock('node:crypto', () => ({randomUUID: mocks.randomUUID}));

vi.mock('fs/promises', () => ({
    mkdir: mocks.mkdir,
    rename: mocks.rename,
    rm: mocks.rm,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));

vi.mock('@electron/features/djvu/main/ddjvu-conversion', () => ({
    cancelConversion: mocks.cancelConversion,
    convertAllPagesToImages: mocks.convertAllPagesToImages,
}));

vi.mock('@electron/djvu/metadata', () => ({
    getDjvuOutline: mocks.getDjvuOutline,
    getDjvuPageCount: mocks.getDjvuPageCount,
    getDjvuResolution: mocks.getDjvuResolution,
}));

vi.mock('@electron/djvu/bookmarks', () => ({parseDjvuOutline: mocks.parseDjvuOutline}));
vi.mock('@electron/djvu/pdf-builder', () => ({buildOptimizedPdf: mocks.buildOptimizedPdf}));
vi.mock('@electron/djvu/pdf-bookmarks', () => ({embedBookmarksIntoPdf: mocks.embedBookmarksIntoPdf}));
vi.mock('@electron/djvu/export-paths', () => ({consumeAllowedDjvuWritePath: mocks.consumeAllowedDjvuWritePath}));
vi.mock('@electron/djvu/ipc-shared', () => ({safeSendToWindow: mocks.safeSendToWindow}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: vi.fn(),
})}));

vi.mock('@electron/features/djvu/main/pdf-worker-client', () => ({
    createDjvuPdfBuildTask: mocks.createDjvuPdfBuildTask,
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
        mocks.buildTaskState.mode = 'success';
        mocks.buildTaskState.rejectPendingBuild = null;
        mocks.buildTaskState.workerTerminate = vi.fn(() => {
            mocks.buildTaskState.rejectPendingBuild?.(new Error('worker terminated'));
            return Promise.resolve(0);
        });

        mocks.randomUUID
            .mockReturnValueOnce('convert-123')
            .mockReturnValue('temp-456');
        mocks.mkdir.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.rename.mockResolvedValue(undefined);
        mocks.unlink.mockRejectedValue(new Error('missing temp file'));
        mocks.rm.mockResolvedValue(undefined);
        mocks.getDjvuPageCount.mockResolvedValue(2);
        mocks.getDjvuResolution.mockResolvedValue(300);
        mocks.getDjvuOutline.mockResolvedValue('(bookmarks)');
        mocks.parseDjvuOutline.mockReturnValue([{
            title: 'Chapter 1',
            pageIndex: 0,
            items: [],
        }]);
        mocks.convertAllPagesToImages.mockImplementation(async (
            _djvuPath: string,
            _imageDir: string,
            totalPages: number,
            _jobId: string,
            options?: { onPageConverted?: (completed: number, total: number) => void },
        ) => {
            options?.onPageConverted?.(totalPages, totalPages);
            return {success: true};
        });
        mocks.cancelConversion.mockReturnValue(false);
        mocks.buildOptimizedPdf.mockResolvedValue(new Uint8Array([
            5,
            5,
        ]));
        mocks.embedBookmarksIntoPdf.mockResolvedValue(new Uint8Array([
            6,
            6,
        ]));
        mocks.createDjvuPdfBuildTask.mockImplementation((_imagePaths: string[], _dpi: number, onProgress?: (progress: {
            type: 'progress';
            phase: 'buildPdf';
            page: number;
            total: number;
        }) => void) => {
            if (mocks.buildTaskState.mode === 'startup-error') {
                throw new mocks.StartupError('worker missing');
            }

            if (mocks.buildTaskState.mode === 'cancel-pending') {
                const promise = new Promise<Uint8Array>((_resolve, reject) => {
                    mocks.buildTaskState.rejectPendingBuild = reject;
                });
                return {
                    worker: { terminate: mocks.buildTaskState.workerTerminate },
                    promise,
                };
            }

            onProgress?.({
                type: 'progress',
                phase: 'buildPdf',
                page: 2,
                total: 2,
            });
            return {
                worker: { terminate: mocks.buildTaskState.workerTerminate },
                promise: Promise.resolve(new Uint8Array([
                    1,
                    2,
                ])),
            };
        });
        mocks.createDjvuPdfBookmarkTask.mockImplementation((pdfData: Uint8Array) => ({
            worker: { terminate: vi.fn(() => Promise.resolve(0)) },
            promise: Promise.resolve(pdfData),
        }));
        mocks.consumeAllowedDjvuWritePath.mockImplementation((outputPath: string) => outputPath);
    });

    it('falls back to in-process PDF build and bookmark embedding when worker startup fails', async () => {
        mocks.buildTaskState.mode = 'startup-error';
        mocks.createDjvuPdfBookmarkTask.mockImplementation(() => {
            throw new mocks.StartupError('bookmark worker missing');
        });

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
        expect(mocks.createDjvuPdfBuildTask).toHaveBeenCalledTimes(1);
        expect(mocks.buildOptimizedPdf).toHaveBeenCalledTimes(1);
        expect(mocks.createDjvuPdfBookmarkTask).toHaveBeenCalledTimes(1);
        expect(mocks.embedBookmarksIntoPdf).toHaveBeenCalledTimes(1);
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(2);
    });

    it('terminates the active PDF worker when cancel is requested', async () => {
        mocks.buildTaskState.mode = 'cancel-pending';

        const convertPromise = handleDjvuConvertToPdf(
            {sender: {id: 7}} as never,
            '/tmp/input.djvu',
            '/tmp/output.pdf',
            {preserveBookmarks: false},
        );

        for (let attempt = 0; attempt < 5 && mocks.createDjvuPdfBuildTask.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        const cancelResult = handleDjvuCancel(
            {sender: {id: 7}} as never,
            'djvu-convert-convert-123',
        );
        const result = await convertPromise;

        expect(cancelResult).toEqual({canceled: true});
        expect(mocks.buildTaskState.workerTerminate).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            success: false,
            jobId: 'djvu-convert-convert-123',
            error: 'DjVu conversion canceled',
        });
    });
});
