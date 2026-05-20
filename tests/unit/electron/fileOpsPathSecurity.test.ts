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
    statSync: vi.fn<(path: string) => { size: number }>(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
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
    ensureWorkingCopyDirectory: vi.fn<(path: string) => Promise<boolean>>(),
    isAllowedDjvuViewingPath: vi.fn<(path: string) => boolean>(),
}));

vi.mock('fs', () => ({
    existsSync: (path: string) => mocks.existsSync(path),
    lstatSync: (path: string) => mocks.lstatSync(path),
    realpathSync: (path: string) => mocks.realpathSync(path),
    statSync: (path: string) => mocks.statSync(path),
}));

vi.mock('fs/promises', () => ({
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
vi.mock('@electron/ipc/docxExportPaths', () => ({consumeAllowedDocxWritePath: mocks.consumeAllowedDocxWritePath}));
vi.mock('@electron/ipc/workingCopyCreation', () => ({ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory}));
vi.mock('@electron/ipc/workingCopyStore', () => ({findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath}));
vi.mock('@electron/djvu/viewing', () => ({isAllowedDjvuViewingPath: mocks.isAllowedDjvuViewingPath}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const {
    handleFileRead,
    handleFileReadRange,
    handleFileStat,
} = await import('@electron/features/documents/main/documentFileReadHandlers');
const {
    handleFileWrite,
    handleFileWriteDocx,
} = await import('@electron/features/documents/main/documentFileWriteHandlers');
const { handleAnalyzePdfConformance } = await import('@electron/features/documents/main/documentPdfValidationHandlers');

describe('fileOps path security', () => {
    const event = {sender: {id: 42}} as Electron.IpcMainInvokeEvent;

    beforeEach(() => {
        vi.resetAllMocks();

        mocks.existsSync.mockReturnValue(true);
        mocks.isAllowedReadPath.mockReturnValue(true);
        mocks.isAllowedWritePath.mockReturnValue(true);
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/safe.pdf');
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/safe.pdf');
        mocks.consumeAllowedDocxWritePath.mockReturnValue(true);
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.isAllowedDjvuViewingPath.mockReturnValue(false);
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
        mocks.statSync.mockReturnValue({ size: 123 });
        mocks.stat.mockResolvedValue({ size: 123 });
        mocks.writeFile.mockResolvedValue(undefined);
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
                {} as never,
                '/tmp/electron-test/symlink.pdf',
            ),
        ).rejects.toThrow('Invalid file path: reads only allowed within temp directory');

        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('rejects write when pathValidator blocks a symlink path', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue(null);

        await expect(
            handleFileWrite(
                {} as never,
                '/tmp/electron-test/symlink-output.pdf',
                new Uint8Array([9]),
            ),
        ).rejects.toThrow('Invalid file path: writes only allowed within temp directory');

        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('ensures mapped working copy directories before writing temp PDF bytes', async () => {
        await handleFileWrite(
            {} as never,
            '/tmp/electron-test/safe.pdf',
            new Uint8Array([9]),
        );

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/electron-test/safe.pdf', undefined);
        expect(mocks.open).toHaveBeenCalledWith(expect.stringMatching(/\/\.safe\.pdf\.\d+\..+\.tmp$/u), 'wx');
        expect(mocks.writeFile).toHaveBeenCalledWith(new Uint8Array([9]));
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/\/\.safe\.pdf\.\d+\..+\.tmp$/u),
            '/tmp/electron-test/safe.pdf',
        );
    });

    it('allows writes through standard macOS temp path aliases', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/var/folders/evb/safe.pdf');
        mocks.lstatSync.mockImplementation((path: string) => ({isSymbolicLink: () => path === '/var'}));
        mocks.realpathSync.mockImplementation((path: string) => (path === '/var' ? '/private/var' : path));

        await handleFileWrite(
            {} as never,
            '/var/folders/evb/safe.pdf',
            new Uint8Array([9]),
        );

        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/\/var\/folders\/evb\/\.safe\.pdf\.\d+\..+\.tmp$/u),
            '/var/folders/evb/safe.pdf',
        );
    });

    it('rejects writes through non-system symlink path segments', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/link/safe.pdf');
        mocks.lstatSync.mockImplementation((path: string) => ({isSymbolicLink: () => path === '/tmp/electron-test/link'}));

        await expect(
            handleFileWrite(
                {} as never,
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
                {} as never,
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
            {} as never,
            '/tmp/electron-test/safe.pdf',
            new Uint8Array([9]),
        );

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledTimes(2);
        expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    });

    it('falls back to mapped working copy for original file path reads', async () => {
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/electron-test/mapped.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/electron-test/mapped.pdf');

        const content = await handleFileRead(event, '/Users/alice/Documents/file.pdf');

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 42);
        expect(mocks.readFile).toHaveBeenCalledWith('/tmp/electron-test/mapped.pdf');
        expect(content).toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
    });

    it('falls back to mapped working copy for original file path stats', async () => {
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/electron-test/mapped.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/electron-test/mapped.pdf');

        const result = await handleFileStat(event, '/Users/alice/Documents/file.pdf');

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 42);
        expect(mocks.statSync).toHaveBeenCalledWith('/tmp/electron-test/mapped.pdf');
        expect(result).toEqual({ size: 123 });
    });

    it('falls back to mapped working copy for original file path range reads', async () => {
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

        const content = await handleFileReadRange(event, '/Users/alice/Documents/file.pdf', 10, 2);

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 42);
        expect(mocks.open).toHaveBeenCalledWith('/tmp/electron-test/mapped.pdf', 'r');
        expect(content).toEqual(new Uint8Array([
            4,
            5,
        ]));
        expect(close).toHaveBeenCalled();
    });

    it('allows direct reads for DjVu files approved for native viewing', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.realpathSync.mockReturnValue('/Users/alice/Documents/file.djvu');

        const content = await handleFileRead({} as never, '/Users/alice/Documents/file.djvu');

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

        const result = await handleFileStat({} as never, '/Users/alice/Documents/file.djvu');

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

        const content = await handleFileReadRange({} as never, '/Users/alice/Documents/file.djvu', 10, 2);

        expect(mocks.isAllowedDjvuViewingPath).toHaveBeenCalledWith('/Users/alice/Documents/file.djvu');
        expect(mocks.open).toHaveBeenCalledWith('/Users/alice/Documents/file.djvu', 'r');
        expect(content).toEqual(new Uint8Array([
            6,
            7,
        ]));
        expect(close).toHaveBeenCalled();
    });

    it('still rejects direct PDF source reads outside the temp sandbox', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);

        await expect(
            handleFileRead(
                {} as never,
                '/Users/alice/Documents/file.pdf',
            ),
        ).rejects.toThrow('Invalid file path: reads only allowed within temp directory');

        expect(mocks.isAllowedDjvuViewingPath).not.toHaveBeenCalled();
    });

    it('routes PDF conformance checks through the worker-backed helper', async () => {
        const result = await handleAnalyzePdfConformance(event, '/tmp/electron-test/safe.pdf');

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
                event,
                '/tmp/electron-test/export.docx',
                'not-bytes',
            ),
        ).rejects.toThrow('Invalid data: must be a Uint8Array');

        expect(mocks.consumeAllowedDocxWritePath).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('consumes DOCX write grants for the invoking sender only', async () => {
        await handleFileWriteDocx(
            event,
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
});
