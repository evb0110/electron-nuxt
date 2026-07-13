import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    addRecentInputs: vi.fn(async (_paths: string[], _owner?: unknown) => undefined),
    allowOpenPaths: vi.fn(),
    buildCombinedPdfOutputPath: vi.fn((_paths: string[]) => '/tmp/combined.pdf'),
    createPdfFileFromInputPaths: vi.fn(async (
        _inputPaths: string[],
        outputPath: string,
        _options?: unknown,
    ) => outputPath),
    createWorkingCopy: vi.fn(async (_originalPath: string, _ownerWebContentsId?: number) => '/tmp/working/original.pdf'),
    createWorkingCopyFromPath: vi.fn(async (
        _sourcePath: string,
        _originalPath?: string,
        _ownerWebContentsId?: number,
    ) => '/tmp/working/combined.pdf'),
    existsSync: vi.fn((_path: string) => true),
    isDjvuPath: vi.fn((path: string) => /\.(?:djvu|djv)$/iu.test(path)),
    isPdfPath: vi.fn((path: string) => /\.pdf$/iu.test(path)),
    isSupportedOpenPath: vi.fn((_path: string) => true),
    mkdtemp: vi.fn(async (_prefix: string) => '/tmp/pdf-combine-open-test'),
    requireOpenPath: vi.fn((path: string, _owner?: unknown) => path),
    rm: vi.fn(async (_path: string, _options?: unknown) => undefined),
}));

vi.mock('fs', () => ({existsSync: (path: string) => mocks.existsSync(path)}));
vi.mock('fs/promises', () => ({
    mkdtemp: (...args: [string]) => mocks.mkdtemp(...args),
    rm: (...args: [string, unknown]) => mocks.rm(...args),
}));
vi.mock('@electron/image/pdfConversion', () => ({
    buildCombinedPdfOutputPath: (...args: [string[]]) => mocks.buildCombinedPdfOutputPath(...args),
    createPdfFileFromInputPaths: (
        inputPaths: string[],
        outputPath: string,
        options?: unknown,
    ) => mocks.createPdfFileFromInputPaths(inputPaths, outputPath, options),
    isDjvuPath: (path: string) => mocks.isDjvuPath(path),
    isPdfPath: (path: string) => mocks.isPdfPath(path),
    isSupportedOpenPath: (path: string) => mocks.isSupportedOpenPath(path),
}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({
    createWorkingCopy: (originalPath: string, ownerWebContentsId?: number) =>
        mocks.createWorkingCopy(originalPath, ownerWebContentsId),
    createWorkingCopyFromPath: (
        sourcePath: string,
        originalPath?: string,
        ownerWebContentsId?: number,
    ) => mocks.createWorkingCopyFromPath(sourcePath, originalPath, ownerWebContentsId),
}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPaths: (...args: unknown[]) => mocks.allowOpenPaths(...args),
    requireOpenPath: (path: string, owner?: unknown) => mocks.requireOpenPath(path, owner),
}));
vi.mock('@electron/features/documents/main/addRecentInputs.service', () => ({addRecentInputs: (paths: string[], owner?: unknown) => mocks.addRecentInputs(paths, owner)}));
vi.mock('@electron/utils/normalizePossiblyEncodedExistingPath', () => ({normalizePossiblyEncodedExistingPath: () => null}));
vi.mock('@electron/te', () => ({te: (key: string) => key}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
})}));

describe('openInputPaths', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('mints the generated combined PDF temp path before creating a working copy', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        const result = await openInputPaths([
            '/tmp/a.png',
            '/tmp/b.jpg',
        ], {}, owner as never);

        expect(result).toEqual({
            kind: 'pdf',
            workingPath: '/tmp/working/combined.pdf',
            originalPath: '/tmp/combined.pdf',
            isGenerated: true,
        });
        expect(mocks.createPdfFileFromInputPaths).toHaveBeenCalledWith(
            [
                '/tmp/a.png',
                '/tmp/b.jpg',
            ],
            '/tmp/pdf-combine-open-test/combined.pdf',
            { signal: expect.any(AbortSignal) },
        );
        expect(mocks.allowOpenPaths).toHaveBeenCalledWith([
            '/tmp/a.png',
            '/tmp/b.jpg',
        ], owner);
        expect(mocks.allowOpenPaths).toHaveBeenCalledWith(['/tmp/pdf-combine-open-test/combined.pdf'], owner);
        expect(mocks.requireOpenPath).toHaveBeenCalledWith('/tmp/pdf-combine-open-test/combined.pdf', owner);
        expect(mocks.createWorkingCopyFromPath).toHaveBeenCalledWith(
            '/tmp/pdf-combine-open-test/combined.pdf',
            '/tmp/combined.pdf',
            42,
        );
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-combine-open-test', {
            recursive: true,
            force: true,
        });
    });

    it('does not add source PDFs or DjVu files to recents for generated combined PDFs', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths([
            '/tmp/source-a.pdf',
            '/tmp/source-b.djvu',
        ], {}, owner as never)).resolves.toEqual({
            kind: 'pdf',
            workingPath: '/tmp/working/combined.pdf',
            originalPath: '/tmp/combined.pdf',
            isGenerated: true,
        });

        expect(mocks.addRecentInputs).not.toHaveBeenCalled();
    });

    it('keeps adding single PDF opens to recents', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(['/tmp/source.pdf'], {}, owner as never)).resolves.toEqual({
            kind: 'pdf',
            workingPath: '/tmp/working/original.pdf',
            originalPath: '/tmp/source.pdf',
        });

        expect(mocks.addRecentInputs).toHaveBeenCalledWith(['/tmp/source.pdf'], owner);
    });

    it('returns a PDF source before recent-file inspection and persistence settle', async () => {
        let resolveRecent!: () => void;
        const recentPersistence = new Promise<undefined>(resolve => {
            resolveRecent = () => resolve(undefined);
        });
        mocks.addRecentInputs.mockImplementationOnce(() => recentPersistence);
        const owner = {id: 42};
        const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(['/tmp/slow-stat.pdf'], {}, owner as never)).resolves.toEqual({
            kind: 'pdf',
            workingPath: '/tmp/working/original.pdf',
            originalPath: '/tmp/slow-stat.pdf',
        });

        expect(mocks.addRecentInputs).toHaveBeenCalledWith(['/tmp/slow-stat.pdf'], owner);
        resolveRecent();
        await recentPersistence;
    });

    it('always generates a new PDF for a forced single-PDF combine', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(
            ['/tmp/source.pdf'],
            {forceCombine: true},
            owner as never,
        )).resolves.toMatchObject({
            kind: 'pdf',
            isGenerated: true,
            workingPath: '/tmp/working/combined.pdf',
        });
        expect(mocks.createPdfFileFromInputPaths).toHaveBeenCalledOnce();
        expect(mocks.createWorkingCopy).not.toHaveBeenCalled();
    });

    it('keeps adding single DjVu opens to recents', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(['/tmp/source.djvu'], {}, owner as never)).resolves.toEqual({
            kind: 'djvu',
            workingPath: '',
            originalPath: '/tmp/source.djvu',
        });

        expect(mocks.addRecentInputs).toHaveBeenCalledWith(['/tmp/source.djvu'], owner);
    });

    it('always generates a new PDF for a forced single-DjVu combine', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(
            ['/tmp/source.djvu'],
            {forceCombine: true},
            owner as never,
        )).resolves.toMatchObject({
            kind: 'pdf',
            isGenerated: true,
        });
        expect(mocks.createPdfFileFromInputPaths).toHaveBeenCalledOnce();
    });

    it('rejects oversized open batches before granting paths or creating temp files', async () => {
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');
        const paths = Array.from({length: 513}, (_, index) => `/tmp/input-${index}.png`);

        await expect(openInputPaths(paths)).rejects.toThrow('errors.file.invalid');

        expect(mocks.allowOpenPaths).not.toHaveBeenCalled();
        expect(mocks.createPdfFileFromInputPaths).not.toHaveBeenCalled();
        expect(mocks.mkdtemp).not.toHaveBeenCalled();
    });
});
