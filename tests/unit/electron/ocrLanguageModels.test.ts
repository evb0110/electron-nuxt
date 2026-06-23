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
    closeSync: vi.fn(),
    existsSync: vi.fn(),
    fetch: vi.fn(),
    mkdir: vi.fn(),
    openSync: vi.fn(),
    readSync: vi.fn(),
    readdir: vi.fn(),
    rm: vi.fn(),
    statSync: vi.fn(),
    copyFile: vi.fn(),
    fileUrl: '/tmp/app.asar/dist/electron/ocr/languageModels.js',
    app: {
        isPackaged: true,
        getPath: vi.fn(),
    },
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('electron', () => ({app: mocks.app}));
vi.mock('os', () => ({homedir: () => '/tmp/home'}));
vi.mock('url', () => ({fileURLToPath: () => mocks.fileUrl}));
vi.mock('fs', () => ({
    closeSync: (...args: unknown[]) => mocks.closeSync(...args),
    createWriteStream: vi.fn(),
    existsSync: (path: string) => mocks.existsSync(path),
    openSync: (...args: unknown[]) => mocks.openSync(...args),
    readSync: (...args: unknown[]) => mocks.readSync(...args),
    statSync: (...args: unknown[]) => mocks.statSync(...args),
}));
vi.mock('fs/promises', () => ({
    copyFile: (...args: unknown[]) => mocks.copyFile(...args),
    mkdir: (...args: unknown[]) => mocks.mkdir(...args),
    readdir: (...args: unknown[]) => mocks.readdir(...args),
    rename: vi.fn(),
    rm: (...args: unknown[]) => mocks.rm(...args),
    stat: vi.fn(),
    writeFile: vi.fn(),
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

describe('ensureRuntimeTessdataSeeded', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.fileUrl = '/tmp/app.asar/dist/electron/ocr/languageModels.js';
        mocks.app.isPackaged = true;
        mocks.app.getPath.mockReturnValue('/tmp/electron-user-data');
        Object.defineProperty(process, 'resourcesPath', {
            configurable: true,
            value: '/tmp/resources',
        });
        vi.stubGlobal('fetch', mocks.fetch);
        mocks.existsSync.mockImplementation((path: string) =>
            path === '/tmp/resources/tesseract/tessdata'
            || (path.startsWith('/tmp/resources/tesseract/tessdata/') && path.endsWith('.traineddata')),
        );
        mocks.openSync.mockReturnValue(10);
        mocks.closeSync.mockReturnValue(undefined);
        mocks.statSync.mockReturnValue({
            isFile: () => true,
            size: 4096,
        });
        mocks.readSync.mockImplementation((_fd: number, buffer: Buffer) => {
            buffer.writeUInt32LE(1, 0);
            buffer.writeBigInt64LE(12n, 4);
            return 12;
        });
        mocks.mkdir.mockResolvedValue(undefined);
        mocks.rm.mockResolvedValue(undefined);
        mocks.readdir.mockResolvedValue([
            'eng.traineddata',
            'osd.traineddata',
            'notes.txt',
        ]);
        mocks.copyFile.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
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

    it('uses Electron userData as the packaged runtime tessdata base', async () => {
        mocks.app.getPath.mockReturnValue('/tmp/profile/user-data');
        const { getRuntimeTessdataDir } = await import('@electron/ocr/languageModels');

        expect(getRuntimeTessdataDir()).toBe('/tmp/profile/user-data/tessdata');
        expect(mocks.app.getPath).toHaveBeenCalledWith('userData');
    });

    it('resolves bundled tessdata from the repository resources directory in development', async () => {
        mocks.fileUrl = '/repo/electron/ocr/languageModels.ts';
        mocks.app.isPackaged = false;
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        mocks.existsSync.mockImplementation((path: string) => path === '/repo/resources/tesseract');
        const { getRuntimeTessdataDir } = await import('@electron/ocr/languageModels');

        expect(getRuntimeTessdataDir()).toBe('/repo/resources/tesseract/tessdata');
    });

    it('uses a pinned tessdata_best source ref', async () => {
        const { TESSDATA_BEST_REF } = await import('@electron/ocr/languageModels');

        expect(TESSDATA_BEST_REF).toMatch(/^[a-f0-9]{40}$/u);
        expect(TESSDATA_BEST_REF).toBe('e12c65a915945e4c28e237a9b52bc4a8f39a0cec');
    });

    it('validates traineddata headers with a deterministic readability check', async () => {
        mocks.existsSync.mockImplementation((path: string) => path.endsWith('.traineddata'));
        const { validateTraineddataFile } = await import('@electron/ocr/languageModels');

        expect(validateTraineddataFile('/tmp/eng.traineddata')).toEqual({valid: true});

        mocks.readSync.mockImplementationOnce((_fd: number, buffer: Buffer) => {
            buffer.writeUInt32LE(1, 0);
            buffer.writeBigInt64LE(99_999n, 4);
            return 12;
        });

        expect(validateTraineddataFile('/tmp/bad.traineddata')).toMatchObject({
            valid: false,
            error: expect.stringContaining('out-of-range component offset'),
        });
    });

    it('treats offline model downloads as retryable after precheck', async () => {
        mocks.fileUrl = '/repo/electron/ocr/languageModels.ts';
        mocks.app.isPackaged = false;
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        mocks.existsSync.mockImplementation((path: string) => path === '/repo/resources/tesseract');
        const offlineError = Object.assign(new Error('getaddrinfo EAI_AGAIN raw.githubusercontent.com'), {code: 'EAI_AGAIN'});
        mocks.fetch.mockRejectedValue(offlineError);

        const { ensureTessdataLanguages } = await import('@electron/ocr/languageModels');

        await expect(ensureTessdataLanguages(['eng'])).rejects.toMatchObject({
            retryable: true,
            code: 'NETWORK_UNREACHABLE',
        });
        expect(mocks.fetch).toHaveBeenCalledTimes(4);
        expect(String(mocks.fetch.mock.calls[0]?.[0])).toContain(
            'raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/eng.traineddata',
        );
    });
});
