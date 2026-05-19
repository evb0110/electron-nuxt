import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
    fileUrl: '/repo/electron/ocr/paths.ts',
    ensureRuntimeTessdataSeeded: vi.fn(),
}));

vi.mock('url', () => ({fileURLToPath: () => mocks.fileUrl}));
vi.mock('fs', () => ({
    existsSync: (path: string) => mocks.existsSync(path),
    readdirSync: vi.fn(),
}));
vi.mock('child_process', () => ({spawn: vi.fn()}));
vi.mock('@electron/utils/platformArch', () => ({resolvePlatformArchTag: () => 'darwin-arm64'}));
vi.mock('@electron/ocr/languageModels', () => ({
    ensureRuntimeTessdataSeeded: () => mocks.ensureRuntimeTessdataSeeded(),
    getRuntimeTessdataDir: () => '/repo/resources/tesseract/tessdata',
}));

describe('getOcrToolPaths resource base resolution', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        mocks.ensureRuntimeTessdataSeeded.mockResolvedValue(undefined);
        mocks.existsSync.mockImplementation((path: string) => [
            '/repo/resources/tesseract',
            '/repo/resources/tesseract/darwin-arm64/bin/tesseract',
        ].includes(path));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('builds tool paths from repository resources when loaded from source', async () => {
        const { getOcrToolPaths } = await import('@electron/ocr/paths');

        expect(getOcrToolPaths()).toMatchObject({
            tesseract: '/repo/resources/tesseract/darwin-arm64/bin/tesseract',
            tessdata: '/repo/resources/tesseract/tessdata',
            pdftoppm: 'pdftoppm',
            pdftotext: 'pdftotext',
            qpdf: 'qpdf',
        });
    });
});
