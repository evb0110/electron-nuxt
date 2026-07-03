import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn<(path: string) => boolean>(),
    lstatSync: vi.fn<(path: string) => { isSymbolicLink: () => boolean; }>(),
    realpathSync: vi.fn<(path: string) => string>(),
    statSync: vi.fn<(path: string) => {
        size: number;
        mtimeMs?: number;
    }>(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    copyFile: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
    open: vi.fn(),
    isAllowedReadPath: vi.fn<(path: string) => boolean>(),
    isAllowedWritePath: vi.fn<(path: string) => boolean>(),
    resolveAllowedReadPath: vi.fn<(path: string) => Promise<string | null>>(),
    resolveAllowedWritePath: vi.fn<(path: string) => Promise<string | null>>(),
    analyzePdfConformanceFile: vi.fn(),
    consumeAllowedDocxWritePath: vi.fn<(path: string, senderId: number) => boolean>(),
    findWorkingCopyPathByOriginalPath: vi.fn<(path: string, senderId?: number) => string | null>(),
    getWorkingCopyOriginalPath: vi.fn(),
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn<(path: string, senderId?: number) => Promise<boolean>>(),
    originalPathSaveBaseMatches: vi.fn(),
    isAllowedDjvuViewingPath: vi.fn<(path: string) => boolean>(),
    findPendingOcrResultFileForPath: vi.fn(),
}));

vi.mock('fs', () => ({
    existsSync: (path: string) => mocks.existsSync(path),
    lstatSync: (path: string) => mocks.lstatSync(path),
    realpathSync: (path: string) => mocks.realpathSync(path),
    statSync: (path: string) => mocks.statSync(path),
}));

vi.mock('fs/promises', () => ({
    copyFile: mocks.copyFile,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    stat: mocks.stat,
    unlink: mocks.unlink,
    rename: mocks.rename,
    open: mocks.open,
}));

vi.mock('@electron/utils/pathValidator', () => ({
    isAllowedReadPath: mocks.isAllowedReadPath,
    isAllowedWritePath: mocks.isAllowedWritePath,
    resolveAllowedReadPath: mocks.resolveAllowedReadPath,
    resolveAllowedWritePath: mocks.resolveAllowedWritePath,
}));

vi.mock('@electron/features/documents/main/pdfConformance', () => ({
    analyzePdfConformanceFile: mocks.analyzePdfConformanceFile,
    validatePdfData: vi.fn(),
}));
vi.mock('@electron/file-access/docxExportPaths', () => ({consumeAllowedDocxWritePath: mocks.consumeAllowedDocxWritePath}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath,
    getWorkingCopyOriginalPath: mocks.getWorkingCopyOriginalPath,
    normalizePathForLookup: (path: string) => path.trim(),
    refreshWorkingCopyOriginalFileExpectation: mocks.refreshWorkingCopyOriginalFileExpectation,
}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({markWorkingCopyContentChanged: mocks.markWorkingCopyContentChanged}));
vi.mock('@electron/features/documents/main/originalPathSaveBaseMatches', () => ({originalPathSaveBaseMatches: mocks.originalPathSaveBaseMatches}));
vi.mock('@electron/djvu/viewing', () => ({isAllowedDjvuViewingPath: mocks.isAllowedDjvuViewingPath}));
vi.mock('@electron/ocr/createPendingResultFileStore', () => ({findPendingOcrResultFileForPath: mocks.findPendingOcrResultFileForPath}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const {
    clearCachedRangeReadHandlesForTests,
    handleFileRead,
    handleFileReadRange,
    handleFileStat,
} = await import('@electron/features/documents/main/documentFileReadHandlers');
const {
    handleFileWrite,
    handleFileWriteDocx,
    handleReplaceWorkingCopyFromPath,
} = await import('@electron/features/documents/main/documentFileWriteHandlers');
const { handleCleanupOcrTemp } = await import('@electron/features/documents/main/handleCleanupOcrTemp');
const { handleAnalyzePdfConformance } = await import('@electron/features/documents/main/documentPdfValidationHandlers');
const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');

describe('fileOps path security', () => {
    const readContext = {senderId: 42};
    const writeContext = {senderId: 42};

    beforeEach(async () => {
        await clearCachedRangeReadHandlesForTests();
        vi.resetAllMocks();

        mocks.existsSync.mockReturnValue(true);
        mocks.isAllowedReadPath.mockReturnValue(true);
        mocks.isAllowedWritePath.mockReturnValue(true);
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/safe.pdf');
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/safe.pdf');
        mocks.consumeAllowedDocxWritePath.mockReturnValue(true);
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
        mocks.getWorkingCopyOriginalPath.mockReturnValue(null);
        mocks.originalPathSaveBaseMatches.mockResolvedValue(true);
        mocks.markWorkingCopyContentChanged.mockResolvedValue({});
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.isAllowedDjvuViewingPath.mockReturnValue(false);
        mocks.findPendingOcrResultFileForPath.mockReturnValue({
            scopedJobId: '42:ocr-1',
            requestId: 'ocr-1',
            webContentsId: 42,
            pdfPath: '/tmp/electron-test/ocr-1-merged.pdf',
            createdAtMs: Date.now(),
            cleanupTimer: null,
        });
        mocks.readFile.mockResolvedValue(Buffer.from([
            1,
            2,
            3,
        ]));
        mocks.analyzePdfConformanceFile.mockResolvedValue({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
        mocks.lstatSync.mockReturnValue({ isSymbolicLink: () => false });
        mocks.realpathSync.mockImplementation((path: string) => path);
        mocks.statSync.mockReturnValue({
            size: 123,
            mtimeMs: 1,
        });
        mocks.stat.mockResolvedValue({ size: 123 });
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.rename.mockResolvedValue(undefined);
        mocks.unlink.mockResolvedValue(undefined);
        mocks.open.mockImplementation(async () => ({
            writeFile: mocks.writeFile,
            sync: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
            read: vi.fn(async (buffer: Buffer) => ({
                bytesRead: buffer.byteLength,
                buffer,
            })),
        }));
    });

    it('rejects read when pathValidator blocks a symlink path', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);

        await expect(
            handleFileRead(
                {},
                '/tmp/electron-test/symlink.pdf',
            ),
        ).rejects.toThrow('Invalid file path: reads only allowed within temp directory');

        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('rejects write when pathValidator blocks a symlink path', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue(null);

        await expect(
            handleFileWrite(
                writeContext,
                '/tmp/electron-test/symlink-output.pdf',
                new Uint8Array([9]),
            ),
        ).rejects.toThrow('Invalid file path: writes only allowed within temp directory');

        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('ensures mapped working copy directories before writing temp PDF bytes', async () => {
        await handleFileWrite(
            writeContext,
            '/tmp/electron-test/safe.pdf',
            new Uint8Array([9]),
        );

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/electron-test/safe.pdf', 42);
        expect(mocks.open).toHaveBeenCalledWith(expect.stringMatching(/\/\.safe\.pdf\.\d+\..+\.tmp$/u), 'wx');
        expect(mocks.writeFile).toHaveBeenCalledWith(new Uint8Array([9]));
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/\/\.safe\.pdf\.\d+\..+\.tmp$/u),
            '/tmp/electron-test/safe.pdf',
        );
        expect(mocks.markWorkingCopyContentChanged)
            .toHaveBeenCalledWith('/tmp/electron-test/safe.pdf', 'write', 42);
    });

    it('queues managed working copy writes behind pending mutations', async () => {
        const blockedMutation = deferred<undefined>();
        const queuedMutation = enqueueWorkingCopyMutation('/tmp/electron-test/safe.pdf', () => blockedMutation.promise);

        const writePromise = handleFileWrite(
            writeContext,
            '/tmp/electron-test/safe.pdf',
            new Uint8Array([9]),
        );
        await waitForSettledQueueTurn();

        expect(mocks.writeFile).not.toHaveBeenCalled();
        blockedMutation.resolve(undefined);
        await queuedMutation;
        await writePromise;
        expect(mocks.writeFile).toHaveBeenCalledWith(new Uint8Array([9]));
        expect(mocks.markWorkingCopyContentChanged)
            .toHaveBeenCalledWith('/tmp/electron-test/safe.pdf', 'write', 42);
    });

    it('allows writes through standard macOS temp path aliases', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/var/folders/evb/safe.pdf');
        mocks.lstatSync.mockImplementation((path: string) => ({isSymbolicLink: () => path === '/var'}));
        mocks.realpathSync.mockImplementation((path: string) => (path === '/var' ? '/private/var' : path));

        await handleFileWrite(
            writeContext,
            '/var/folders/evb/safe.pdf',
            new Uint8Array([9]),
        );

        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/\/var\/folders\/evb\/\.safe\.pdf\.\d+\..+\.tmp$/u),
            '/var/folders/evb/safe.pdf',
        );
        expect(mocks.markWorkingCopyContentChanged)
            .toHaveBeenCalledWith('/var/folders/evb/safe.pdf', 'write', 42);
    });

    it('rejects writes through non-system symlink path segments', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/link/safe.pdf');
        mocks.lstatSync.mockImplementation((path: string) => ({isSymbolicLink: () => path === '/tmp/electron-test/link'}));

        await expect(
            handleFileWrite(
                writeContext,
                '/tmp/electron-test/link/safe.pdf',
                new Uint8Array([9]),
            ),
        ).rejects.toThrow('Invalid file path: symlink path segment is not allowed (/tmp/electron-test/link)');

        expect(mocks.open).not.toHaveBeenCalled();
    });

    it('does not write temp PDF bytes when managed working copy recovery fails', async () => {
        const error = new Error('Working copy directory was removed and the original file is unavailable');
        Object.assign(error, { code: 'WORKING_COPY_MISSING' });
        mocks.ensureWorkingCopyDirectory.mockRejectedValue(error);

        await expect(
            handleFileWrite(
                writeContext,
                '/tmp/electron-test/safe.pdf',
                new Uint8Array([9]),
            ),
        ).rejects.toMatchObject({ code: 'WORKING_COPY_MISSING' });

        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('rechecks managed working copy directories and retries when the write races cleanup', async () => {
        const enoent = new Error('missing parent');
        Object.assign(enoent, { code: 'ENOENT' });
        mocks.writeFile
            .mockRejectedValueOnce(enoent)
            .mockResolvedValueOnce(undefined);

        await handleFileWrite(
            writeContext,
            '/tmp/electron-test/safe.pdf',
            new Uint8Array([9]),
        );

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledTimes(3);
        expect(mocks.writeFile).toHaveBeenCalledTimes(2);
        expect(mocks.markWorkingCopyContentChanged)
            .toHaveBeenCalledWith('/tmp/electron-test/safe.pdf', 'write', 42);
    });

    it('atomically replaces a managed working copy from an OCR result file path', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/work.pdf');
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/ocr-1-merged.pdf');

        await handleReplaceWorkingCopyFromPath(
            writeContext,
            '/tmp/electron-test/work.pdf',
            '/tmp/electron-test/ocr-1-merged.pdf',
        );

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/electron-test/work.pdf', 42);
        expect(mocks.copyFile).toHaveBeenCalledWith(
            '/tmp/electron-test/ocr-1-merged.pdf',
            expect.stringMatching(/\/\.work\.pdf\.\d+\..+\.tmp$/u),
        );
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/\/\.work\.pdf\.\d+\..+\.tmp$/u),
            '/tmp/electron-test/work.pdf',
        );
        expect(mocks.markWorkingCopyContentChanged)
            .toHaveBeenCalledWith('/tmp/electron-test/work.pdf', 'ocr-apply', 42);
    });

    it('refreshes the original save base after an OCR replacement when the previous base still matches', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/work.pdf');
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/ocr-1-merged.pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({
            originalPath: '/Users/alice/Documents/book.pdf',
            retired: false,
        });
        mocks.originalPathSaveBaseMatches.mockResolvedValue(true);

        await handleReplaceWorkingCopyFromPath(
            writeContext,
            '/tmp/electron-test/work.pdf',
            '/tmp/electron-test/ocr-1-merged.pdf',
        );

        expect(mocks.originalPathSaveBaseMatches).toHaveBeenCalledWith(
            '/tmp/electron-test/work.pdf',
            '/Users/alice/Documents/book.pdf',
            42,
        );
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(
            '/tmp/electron-test/work.pdf',
            42,
        );
        expect(mocks.rename.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.refreshWorkingCopyOriginalFileExpectation.mock.invocationCallOrder[0]!);
        expect(mocks.markWorkingCopyContentChanged)
            .toHaveBeenCalledWith('/tmp/electron-test/work.pdf', 'ocr-apply', 42);
    });

    it('preserves the stale-original guard after an OCR replacement when the previous base no longer matches', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/work.pdf');
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/ocr-1-merged.pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({
            originalPath: '/Users/alice/Documents/book.pdf',
            retired: false,
        });
        mocks.originalPathSaveBaseMatches.mockResolvedValue(false);

        await handleReplaceWorkingCopyFromPath(
            writeContext,
            '/tmp/electron-test/work.pdf',
            '/tmp/electron-test/ocr-1-merged.pdf',
        );

        expect(mocks.copyFile).toHaveBeenCalled();
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
    });

    it('rejects working-copy replacement from non-OCR source file names', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/work.pdf');
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/unrelated.pdf');

        await expect(
            handleReplaceWorkingCopyFromPath(
                writeContext,
                '/tmp/electron-test/work.pdf',
                '/tmp/electron-test/unrelated.pdf',
            ),
        ).rejects.toThrow('Invalid source path: only OCR result files can replace a working copy');

        expect(mocks.copyFile).not.toHaveBeenCalled();
    });

    it('rejects working-copy replacement from OCR-looking files without pending-result ownership', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/work.pdf');
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/ocr-1-merged.pdf');
        mocks.findPendingOcrResultFileForPath.mockReturnValue(null);

        await expect(
            handleReplaceWorkingCopyFromPath(
                writeContext,
                '/tmp/electron-test/work.pdf',
                '/tmp/electron-test/ocr-1-merged.pdf',
            ),
        ).rejects.toThrow('Invalid source path: OCR result is not owned by this renderer');

        expect(mocks.findPendingOcrResultFileForPath).toHaveBeenCalledWith(42, '/tmp/electron-test/ocr-1-merged.pdf');
        expect(mocks.copyFile).not.toHaveBeenCalled();
    });

    it('deletes legacy OCR temp files only when pending ownership matches the sender', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/ocr-1-merged.pdf');

        await handleCleanupOcrTemp(readContext, '/tmp/electron-test/ocr-1-merged.pdf');

        expect(mocks.findPendingOcrResultFileForPath).toHaveBeenCalledWith(42, '/tmp/electron-test/ocr-1-merged.pdf');
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/electron-test/ocr-1-merged.pdf');
    });

    it('does not delete legacy OCR temp files without pending ownership', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/ocr-1-merged.pdf');
        mocks.findPendingOcrResultFileForPath.mockReturnValue(null);

        await handleCleanupOcrTemp(readContext, '/tmp/electron-test/ocr-1-merged.pdf');

        expect(mocks.findPendingOcrResultFileForPath).toHaveBeenCalledWith(42, '/tmp/electron-test/ocr-1-merged.pdf');
        expect(mocks.unlink).not.toHaveBeenCalled();
    });

    it('falls back to mapped working copy for original file path reads', async () => {
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(false);
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/electron-test/mapped.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/electron-test/mapped.pdf');

        const content = await handleFileRead(readContext, '/Users/alice/Documents/file.pdf');

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 42);
        expect(mocks.readFile).toHaveBeenCalledWith('/tmp/electron-test/mapped.pdf');
        expect(content).toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
    });

    it('falls back to mapped working copy for original file path stats', async () => {
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(false);
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/electron-test/mapped.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/electron-test/mapped.pdf');

        const result = await handleFileStat(readContext, '/Users/alice/Documents/file.pdf');

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 42);
        expect(mocks.statSync).toHaveBeenCalledWith('/tmp/electron-test/mapped.pdf');
        expect(result).toEqual({ size: 123 });
    });

    it('falls back to mapped working copy for original file path range reads', async () => {
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(false);
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/electron-test/mapped.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/electron-test/mapped.pdf');
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer) => {
            buffer.set([
                4,
                5,
            ]);
            return { bytesRead: 2 };
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        const content = await handleFileReadRange(readContext, '/Users/alice/Documents/file.pdf', 10, 2);

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 42);
        expect(mocks.open).toHaveBeenCalledWith('/tmp/electron-test/mapped.pdf', 'r');
        expect(content).toEqual(new Uint8Array([
            4,
            5,
        ]));
        expect(close).not.toHaveBeenCalled();
        await clearCachedRangeReadHandlesForTests();
        expect(close).toHaveBeenCalled();
    });

    it('recreates managed working copies before range reads when direct temp resolution misses', async () => {
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/electron-test/work.pdf');
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer) => {
            buffer.set([
                7,
                8,
            ]);
            return { bytesRead: 2 };
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        const content = await handleFileReadRange(readContext, '/tmp/electron-test/work.pdf', 10, 2);

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/electron-test/work.pdf', 42);
        expect(mocks.open).toHaveBeenCalledWith('/tmp/electron-test/work.pdf', 'r');
        expect(content).toEqual(new Uint8Array([
            7,
            8,
        ]));
        expect(close).not.toHaveBeenCalled();
        await clearCachedRangeReadHandlesForTests();
        expect(close).toHaveBeenCalled();
    });

    it('reuses cached range read handles while the file is unchanged', async () => {
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
            buffer.fill(6, 0, length);
            return { bytesRead: length };
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 0, 2);
        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 2, 2);

        expect(mocks.open).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledTimes(2);
        expect(close).not.toHaveBeenCalled();
        await clearCachedRangeReadHandlesForTests();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('reopens cached range read handles when file metadata changes', async () => {
        const firstClose = vi.fn(async () => {});
        const secondClose = vi.fn(async () => {});
        mocks.statSync
            .mockReturnValueOnce({
                size: 123,
                mtimeMs: 1,
            })
            .mockReturnValueOnce({
                size: 123,
                mtimeMs: 2,
            });
        mocks.open
            .mockResolvedValueOnce({
                close: firstClose,
                read: vi.fn(async (buffer: Buffer) => {
                    buffer.fill(1);
                    return { bytesRead: buffer.byteLength };
                }),
            })
            .mockResolvedValueOnce({
                close: secondClose,
                read: vi.fn(async (buffer: Buffer) => {
                    buffer.fill(2);
                    return { bytesRead: buffer.byteLength };
                }),
            });

        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 0, 2);
        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 2, 2);

        expect(mocks.open).toHaveBeenCalledTimes(2);
        expect(firstClose).toHaveBeenCalledTimes(1);
        expect(secondClose).not.toHaveBeenCalled();
        await clearCachedRangeReadHandlesForTests();
        expect(secondClose).toHaveBeenCalledTimes(1);
    });

    it('closes cached range read handles after working copy mutations settle', async () => {
        const close = vi.fn(async () => {});
        mocks.open.mockResolvedValue({
            close,
            read: vi.fn(async (buffer: Buffer) => {
                buffer.fill(3);
                return { bytesRead: buffer.byteLength };
            }),
        });

        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 0, 2);
        await enqueueWorkingCopyMutation('/tmp/electron-test/safe.pdf', async () => undefined);

        await waitForSettledQueueTurn();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('allows direct reads for DjVu files approved for native viewing', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.realpathSync.mockReturnValue('/Users/alice/Documents/file.djvu');

        const content = await handleFileRead({}, '/Users/alice/Documents/file.djvu');

        expect(mocks.isAllowedDjvuViewingPath).toHaveBeenCalledWith('/Users/alice/Documents/file.djvu');
        expect(mocks.readFile).toHaveBeenCalledWith('/Users/alice/Documents/file.djvu');
        expect(content).toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
    });

    it('allows direct stats for DjVu files approved for native viewing', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.realpathSync.mockReturnValue('/Users/alice/Documents/file.djvu');

        const result = await handleFileStat({}, '/Users/alice/Documents/file.djvu');

        expect(mocks.isAllowedDjvuViewingPath).toHaveBeenCalledWith('/Users/alice/Documents/file.djvu');
        expect(mocks.statSync).toHaveBeenCalledWith('/Users/alice/Documents/file.djvu');
        expect(result).toEqual({ size: 123 });
    });

    it('allows direct range reads for DjVu files approved for native viewing', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.realpathSync.mockReturnValue('/Users/alice/Documents/file.djvu');
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer) => {
            buffer.set([
                6,
                7,
            ]);
            return { bytesRead: 2 };
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        const content = await handleFileReadRange({}, '/Users/alice/Documents/file.djvu', 10, 2);

        expect(mocks.isAllowedDjvuViewingPath).toHaveBeenCalledWith('/Users/alice/Documents/file.djvu');
        expect(mocks.open).toHaveBeenCalledWith('/Users/alice/Documents/file.djvu', 'r');
        expect(content).toEqual(new Uint8Array([
            6,
            7,
        ]));
        expect(close).not.toHaveBeenCalled();
        await clearCachedRangeReadHandlesForTests();
        expect(close).toHaveBeenCalled();
    });

    it('still rejects direct PDF source reads outside the temp sandbox', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);

        await expect(
            handleFileRead(
                {},
                '/Users/alice/Documents/file.pdf',
            ),
        ).rejects.toThrow('Invalid file path: reads only allowed within temp directory');

        expect(mocks.isAllowedDjvuViewingPath).not.toHaveBeenCalled();
    });

    it('routes PDF conformance checks through the worker-backed helper', async () => {
        const result = await handleAnalyzePdfConformance(readContext, '/tmp/electron-test/safe.pdf');

        expect(mocks.analyzePdfConformanceFile).toHaveBeenCalledWith('/tmp/electron-test/safe.pdf');
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(result).toEqual({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
    });

    it('rejects invalid DOCX write payloads before consuming the approved path', async () => {
        await expect(
            handleFileWriteDocx(
                writeContext,
                '/tmp/electron-test/export.docx',
                'not-bytes',
            ),
        ).rejects.toThrow('Invalid data: must be a Uint8Array');

        expect(mocks.consumeAllowedDocxWritePath).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('consumes DOCX write grants for the invoking sender only', async () => {
        await handleFileWriteDocx(
            writeContext,
            '/tmp/electron-test/export.docx',
            new Uint8Array([9]),
        );

        expect(mocks.consumeAllowedDocxWritePath).toHaveBeenCalledWith('/tmp/electron-test/export.docx', 42);
        expect(mocks.open).toHaveBeenCalledWith(
            expect.stringMatching(/\/\.export\.docx\.\d+\..+\.tmp$/u),
            'wx',
        );
        expect(mocks.writeFile).toHaveBeenCalledWith(new Uint8Array([9]));
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/\/\.export\.docx\.\d+\..+\.tmp$/u),
            '/tmp/electron-test/export.docx',
        );
    });

    it('serializes concurrent first range handle opens for the same path', async () => {
        const firstOpen = deferred<{
            close: ReturnType<typeof vi.fn>;
            read: ReturnType<typeof vi.fn>;
        }>();
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer, _offset: number, length: number, position: number) => {
            buffer.fill(position === 0 ? 1 : 2, 0, length);
            return { bytesRead: length };
        });
        mocks.open.mockImplementationOnce(() => firstOpen.promise);

        const firstRead = handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 0, 2);
        const secondRead = handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 2, 2);
        await waitForSettledQueueTurn();

        expect(mocks.open).toHaveBeenCalledTimes(1);

        firstOpen.resolve({
            close,
            read,
        });

        await expect(firstRead).resolves.toEqual(new Uint8Array([
            1,
            1,
        ]));
        await expect(secondRead).resolves.toEqual(new Uint8Array([
            2,
            2,
        ]));
        expect(mocks.open).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });
});

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

async function waitForSettledQueueTurn() {
    await Promise.resolve();
    await Promise.resolve();
}
