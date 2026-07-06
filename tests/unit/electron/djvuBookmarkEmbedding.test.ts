import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    copyFile: vi.fn(),
    mkdtemp: vi.fn(),
    readFile: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
    getPdfNativeToolPaths: vi.fn(),
    isNativePageOpsDisabled: vi.fn(),
    resolveNativePageOpsPath: vi.fn(),
    runNativeToolCommand: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    copyFile: (...args: unknown[]) => mocks.copyFile(...args),
    mkdtemp: (...args: unknown[]) => mocks.mkdtemp(...args),
    readFile: (...args: unknown[]) => mocks.readFile(...args),
    rm: (...args: unknown[]) => mocks.rm(...args),
    stat: (...args: unknown[]) => mocks.stat(...args),
    writeFile: (...args: unknown[]) => mocks.writeFile(...args),
}));
vi.mock('pdf-lib', () => ({PDFDocument: {load: vi.fn()}}));
vi.mock('@pdf-core', () => ({writePdfBookmarkOutlines: vi.fn()}));
vi.mock('@electron/features/page-ops/publicNative', () => ({
    isNativePageOpsDisabled: (...args: unknown[]) => mocks.isNativePageOpsDisabled(...args),
    resolveNativePageOpsPath: (...args: unknown[]) => mocks.resolveNativePageOpsPath(...args),
}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: (...args: unknown[]) => mocks.getPdfNativeToolPaths(...args)}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({debug: vi.fn()})}));

describe('embedBookmarksIntoPdfFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.mkdtemp.mockResolvedValue('/tmp/djvu-bookmarks');
        mocks.readFile.mockResolvedValue(Buffer.from('pdf'));
        mocks.rm.mockResolvedValue(undefined);
        mocks.stat.mockResolvedValue({size: 123});
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.getPdfNativeToolPaths.mockReturnValue({qpdf: '/tmp/qpdf'});
        mocks.isNativePageOpsDisabled.mockReturnValue(false);
        mocks.resolveNativePageOpsPath.mockReturnValue('/tmp/evb-pdf-page-ops');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('rethrows native aborts instead of falling back to pdf-lib', async () => {
        const abortError = new Error('Native bookmark embedding canceled');
        abortError.name = 'AbortError';
        mocks.runNativeToolCommand
            .mockResolvedValueOnce({
                stdout: '2\n',
                stderr: '',
                success: true,
                exitCode: 0,
            })
            .mockRejectedValueOnce(abortError);

        const { embedBookmarksIntoPdfFile } = await import('@electron/djvu/embedBookmarksIntoPdfFile');

        await expect(embedBookmarksIntoPdfFile(
            '/tmp/input.pdf',
            '/tmp/output.pdf',
            [{
                title: 'Chapter 1',
                pageIndex: 0,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }],
        )).rejects.toThrow('Native bookmark embedding canceled');
        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('honors an aborted fallback signal before reading the PDF into memory', async () => {
        mocks.resolveNativePageOpsPath.mockReturnValue(null);
        const abortController = new AbortController();
        abortController.abort(new DOMException('Operation aborted', 'AbortError'));

        const { embedBookmarksIntoPdfFile } = await import('@electron/djvu/embedBookmarksIntoPdfFile');

        await expect(embedBookmarksIntoPdfFile(
            '/tmp/input.pdf',
            '/tmp/output.pdf',
            [{
                title: 'Chapter 1',
                pageIndex: 0,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }],
            abortController.signal,
        )).rejects.toThrow('Operation aborted');
        expect(mocks.readFile).not.toHaveBeenCalled();
    });
});
