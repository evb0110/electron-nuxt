import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
    copyFile: vi.fn(),
    fileUrl: '/tmp/app.asar/dist/electron/ocr/languageModels.js',
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('os', () => ({homedir: () => '/tmp/home'}));
vi.mock('url', () => ({fileURLToPath: () => mocks.fileUrl}));
vi.mock('fs', () => ({
    createWriteStream: vi.fn(),
    existsSync: (path: string) => mocks.existsSync(path),
}));
vi.mock('fs/promises', () => ({
    copyFile: (...args: unknown[]) => mocks.copyFile(...args),
    mkdir: (...args: unknown[]) => mocks.mkdir(...args),
    readdir: (...args: unknown[]) => mocks.readdir(...args),
    rename: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

describe('ensureRuntimeTessdataSeeded', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.fileUrl = '/tmp/app.asar/dist/electron/ocr/languageModels.js';
        Object.defineProperty(process, 'resourcesPath', {
            configurable: true,
            value: '/tmp/resources',
        });
        mocks.existsSync.mockImplementation((path: string) => path === '/tmp/resources/tesseract/tessdata');
        mocks.mkdir.mockResolvedValue(undefined);
        mocks.readdir.mockResolvedValue([
            'eng.traineddata',
            'osd.traineddata',
            'notes.txt',
        ]);
        mocks.copyFile.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('shares one async seed across concurrent callers', async () => {
        const {
            ensureRuntimeTessdataSeeded,
            getRuntimeTessdataDir,
        } = await import('@electron/ocr/languageModels');
        const runtimeDir = getRuntimeTessdataDir();

        await Promise.all([
            ensureRuntimeTessdataSeeded(),
            ensureRuntimeTessdataSeeded(),
        ]);
        await ensureRuntimeTessdataSeeded();

        expect(mocks.readdir).toHaveBeenCalledTimes(1);
        expect(mocks.mkdir).toHaveBeenCalledTimes(1);
        expect(mocks.copyFile).toHaveBeenCalledTimes(2);
        expect(mocks.copyFile).toHaveBeenNthCalledWith(
            1,
            '/tmp/resources/tesseract/tessdata/eng.traineddata',
            join(runtimeDir, 'eng.traineddata'),
        );
        expect(mocks.copyFile).toHaveBeenNthCalledWith(
            2,
            '/tmp/resources/tesseract/tessdata/osd.traineddata',
            join(runtimeDir, 'osd.traineddata'),
        );
    });

    it('resolves bundled tessdata from the repository resources directory in development', async () => {
        mocks.fileUrl = '/repo/electron/ocr/languageModels.ts';
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        mocks.existsSync.mockImplementation((path: string) => path === '/repo/resources/tesseract');
        const { getRuntimeTessdataDir } = await import('@electron/ocr/languageModels');

        expect(getRuntimeTessdataDir()).toBe('/repo/resources/tesseract/tessdata');
    });
});
