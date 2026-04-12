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
    open: vi.fn(),
    isAllowedReadPath: vi.fn<(path: string) => boolean>(),
    isAllowedWritePath: vi.fn<(path: string) => boolean>(),
    resolveAllowedReadPath: vi.fn<(path: string) => Promise<string | null>>(),
    resolveAllowedWritePath: vi.fn<(path: string) => Promise<string | null>>(),
    analyzePdfConformanceFile: vi.fn(),
    consumeAllowedDocxWritePath: vi.fn<(path: string) => boolean>(),
    findWorkingCopyPathByOriginalPath: vi.fn<(path: string) => string | null>(),
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
    open: mocks.open,
}));

vi.mock('@electron/utils/path-validator', () => ({
    isAllowedReadPath: mocks.isAllowedReadPath,
    isAllowedWritePath: mocks.isAllowedWritePath,
    resolveAllowedReadPath: mocks.resolveAllowedReadPath,
    resolveAllowedWritePath: mocks.resolveAllowedWritePath,
}));

vi.mock('@electron/features/documents/main/pdf-conformance', () => ({
    analyzePdfConformanceFile: mocks.analyzePdfConformanceFile,
    validatePdfData: vi.fn(),
}));
vi.mock('@electron/ipc/docxExportPaths', () => ({consumeAllowedDocxWritePath: mocks.consumeAllowedDocxWritePath}));
vi.mock('@electron/ipc/workingCopy', () => ({findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath}));
vi.mock('@electron/djvu/viewing', () => ({isAllowedDjvuViewingPath: mocks.isAllowedDjvuViewingPath}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const {
    handleAnalyzePdfConformance,
    handleFileRead,
    handleFileStat,
    handleFileWrite,
} = await import('@electron/features/documents/main/file-ops');

describe('fileOps path security', () => {
    beforeEach(() => {
        vi.resetAllMocks();

        mocks.existsSync.mockReturnValue(true);
        mocks.isAllowedReadPath.mockReturnValue(true);
        mocks.isAllowedWritePath.mockReturnValue(true);
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/safe.pdf');
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/safe.pdf');
        mocks.consumeAllowedDocxWritePath.mockReturnValue(true);
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
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
    });

    it('rejects read when path-validator blocks a symlink path', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);

        await expect(
            handleFileRead(
                {} as never,
                '/tmp/electron-test/symlink.pdf',
            ),
        ).rejects.toThrow('Invalid file path: reads only allowed within temp directory');

        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('rejects write when path-validator blocks a symlink path', async () => {
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

    it('falls back to mapped working copy for original file path reads', async () => {
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/electron-test/mapped.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/electron-test/mapped.pdf');

        const content = await handleFileRead({} as never, '/Users/alice/Documents/file.pdf');

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf');
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

        const result = await handleFileStat({} as never, '/Users/alice/Documents/file.pdf');

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf');
        expect(mocks.statSync).toHaveBeenCalledWith('/tmp/electron-test/mapped.pdf');
        expect(result).toEqual({ size: 123 });
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
        const result = await handleAnalyzePdfConformance({} as never, '/tmp/electron-test/safe.pdf');

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
});
