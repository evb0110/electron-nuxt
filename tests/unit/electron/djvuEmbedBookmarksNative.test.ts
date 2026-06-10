import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const copyFile = vi.fn(async () => undefined);
    const mkdtemp = vi.fn(async () => '/tmp/djvu-bookmarks-native');
    const readFile = vi.fn(async () => new Uint8Array([
        1,
        2,
        3,
    ]));
    const rm = vi.fn(async () => undefined);
    const stat = vi.fn(async () => ({size: 321}));
    const writeFile = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({save: vi.fn(async () => new Uint8Array([9]))}));
    const writePdfBookmarkOutlines = vi.fn();
    const runNativeToolCommand = vi.fn(async () => undefined);
    const isNativePageOpsDisabled = vi.fn(() => false);
    const resolveNativePageOpsPath = vi.fn(() => '/native/evb-pdf-page-ops');
    const getPdfPageCount = vi.fn(async () => 3);
    const debug = vi.fn();

    return {
        copyFile,
        mkdtemp,
        readFile,
        rm,
        stat,
        writeFile,
        load,
        writePdfBookmarkOutlines,
        runNativeToolCommand,
        isNativePageOpsDisabled,
        resolveNativePageOpsPath,
        getPdfPageCount,
        debug,
    };
});

vi.mock('fs/promises', () => ({
    copyFile: mocks.copyFile,
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    writeFile: mocks.writeFile,
}));

vi.mock('pdf-lib', () => ({PDFDocument: {load: mocks.load}}));

vi.mock('@pdf-core', () => ({writePdfBookmarkOutlines: mocks.writePdfBookmarkOutlines}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runNativeToolCommand}));

vi.mock('@electron/features/page-ops/public', () => ({
    getPdfPageCount: mocks.getPdfPageCount,
    isNativePageOpsDisabled: mocks.isNativePageOpsDisabled,
    resolveNativePageOpsPath: mocks.resolveNativePageOpsPath,
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: mocks.debug,
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
})}));

const { embedBookmarksIntoPdfFile } = await import('@electron/djvu/embedBookmarksIntoPdfFile');

const bookmarks = [{
    title: 'Chapter 1',
    pageIndex: 0,
    namedDest: null,
    bold: false,
    italic: false,
    color: null,
    items: [],
}];

describe('embedBookmarksIntoPdfFile native path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isNativePageOpsDisabled.mockReturnValue(false);
        mocks.resolveNativePageOpsPath.mockReturnValue('/native/evb-pdf-page-ops');
        mocks.runNativeToolCommand.mockResolvedValue(undefined);
        mocks.stat.mockResolvedValue({size: 321});
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('uses evb-pdf-page-ops save-mutations without loading the PDF into pdf-lib', async () => {
        const expectedBookmarkMutation = {
            totalPages: 3,
            untitledLabel: 'Untitled',
            items: bookmarks,
        };

        const size = await embedBookmarksIntoPdfFile('/tmp/input.pdf', '/tmp/output.pdf', bookmarks);

        expect(size).toBe(321);
        expect(mocks.getPdfPageCount).toHaveBeenCalledWith('/tmp/input.pdf');
        expect(mocks.copyFile).toHaveBeenCalledWith('/tmp/input.pdf', '/tmp/djvu-bookmarks-native/input.pdf');
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/djvu-bookmarks-native/bookmarks.json',
            JSON.stringify({bookmarks: expectedBookmarkMutation}),
            'utf8',
        );
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            expect.arrayContaining([
                'save-mutations',
                '--input',
                '/tmp/djvu-bookmarks-native/input.pdf',
                '--output',
                '/tmp/output.pdf',
                '--mutations-file',
                '/tmp/djvu-bookmarks-native/bookmarks.json',
                '--append',
            ]),
            expect.objectContaining({commandLabel: 'evb-pdf-page-ops(djvu-bookmarks)'}),
        );
        expect(mocks.load).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/djvu-bookmarks-native', {
            recursive: true,
            force: true,
        });
    });

    it('falls back to pdf-lib when the native command fails', async () => {
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('native failed'));

        const size = await embedBookmarksIntoPdfFile('/tmp/input.pdf', '/tmp/output.pdf', bookmarks);

        expect(size).toBe(321);
        expect(mocks.debug).toHaveBeenCalledWith(expect.stringContaining('native failed'));
        expect(mocks.readFile).toHaveBeenCalledWith('/tmp/input.pdf');
        expect(mocks.load).toHaveBeenCalledWith(expect.any(Uint8Array), {updateMetadata: false});
        expect(mocks.writePdfBookmarkOutlines).toHaveBeenCalled();
        expect(mocks.writeFile).toHaveBeenLastCalledWith('/tmp/output.pdf', new Uint8Array([9]));
    });

    it('keeps the existing pdf-lib behavior when native page ops are disabled', async () => {
        mocks.isNativePageOpsDisabled.mockReturnValue(true);

        await embedBookmarksIntoPdfFile('/tmp/input.pdf', '/tmp/output.pdf', bookmarks);

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(mocks.readFile).toHaveBeenCalledWith('/tmp/input.pdf');
        expect(mocks.load).toHaveBeenCalled();
    });
});
