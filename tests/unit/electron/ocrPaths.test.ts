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
    app: {isPackaged: false},
    ensureRuntimeTessdataSeeded: vi.fn(),
    readdirSync: vi.fn(),
    runNativeToolCommand: vi.fn(),
}));

vi.mock('electron', () => ({app: mocks.app}));
vi.mock('url', () => ({fileURLToPath: () => mocks.fileUrl}));
vi.mock('fs', () => ({
    existsSync: (path: string) => mocks.existsSync(path),
    readdirSync: (path: string) => mocks.readdirSync(path),
}));
vi.mock('child_process', () => ({spawn: vi.fn()}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/utils/platformArch', () => ({resolvePlatformArchTag: () => 'darwin-arm64'}));
vi.mock('@electron/ocr/languageModels', () => ({
    ensureRuntimeTessdataSeeded: () => mocks.ensureRuntimeTessdataSeeded(),
    getRuntimeTessdataDir: () => '/repo/resources/tesseract/tessdata',
}));

describe('getOcrToolPaths resource base resolution', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.app.isPackaged = false;
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        mocks.ensureRuntimeTessdataSeeded.mockResolvedValue(undefined);
        mocks.readdirSync.mockReturnValue([
            'ara.traineddata',
            'deu.traineddata',
            'ell.traineddata',
            'eng.traineddata',
            'fra.traineddata',
            'grc.traineddata',
            'heb.traineddata',
            'kmr.traineddata',
            'rus.traineddata',
            'syr.traineddata',
            'tur.traineddata',
            'README',
        ]);
        mocks.runNativeToolCommand.mockResolvedValue({
            exitCode: 0,
            stdout: '/usr/bin/tool\n',
            stderr: '',
        });
        mocks.existsSync.mockImplementation((path: string) => [
            '/repo/resources/tesseract',
            '/repo/resources/tesseract/darwin-arm64/bin/tesseract',
            '/repo/resources/tesseract/tessdata',
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

    it('validates available OCR tools, language models, and tesseract version', async () => {
        mocks.runNativeToolCommand.mockImplementation(async (command: string) => ({
            exitCode: 0,
            stdout: command.includes('tesseract') ? 'tesseract 5.5.0\n' : '/usr/bin/tool\n',
            stderr: '',
        }));
        const { validateOcrTools } = await import('@electron/ocr/paths');

        await expect(validateOcrTools()).resolves.toEqual({
            valid: true,
            errors: [],
            tools: {
                tesseract: {
                    found: true,
                    path: '/repo/resources/tesseract/darwin-arm64/bin/tesseract',
                    version: '5.5.0',
                },
                tessdata: {
                    found: true,
                    path: '/repo/resources/tesseract/tessdata',
                    languages: [
                        'ara',
                        'deu',
                        'ell',
                        'eng',
                        'fra',
                        'grc',
                        'heb',
                        'kmr',
                        'rus',
                        'syr',
                        'tur',
                    ],
                },
                pdftoppm: {
                    found: true,
                    path: 'pdftoppm',
                },
                pdftotext: {
                    found: true,
                    path: 'pdftotext',
                },
                popplerRuntime: {
                    dataDirFound: false,
                    fontConfigDirFound: false,
                },
                qpdf: {
                    found: true,
                    path: 'qpdf',
                },
            },
        });
    });

    it('reports missing binaries and missing tessdata without probing versions', async () => {
        mocks.existsSync.mockReturnValue(false);
        mocks.runNativeToolCommand.mockResolvedValue({
            exitCode: -1,
            stdout: '',
            stderr: 'not found',
        });
        const { validateOcrTools } = await import('@electron/ocr/paths');

        const result = await validateOcrTools();

        expect(result.valid).toBe(false);
        expect(result.tools.tesseract).toEqual({
            found: false,
            path: 'tesseract',
        });
        expect(result.tools.tessdata).toEqual({
            found: false,
            path: '/repo/resources/tesseract/tessdata',
        });
        expect(result.tools.pdftoppm.found).toBe(false);
        expect(result.tools.pdftotext.found).toBe(false);
        expect(result.tools.qpdf.found).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            'Tesseract binary not found: tesseract',
            'Tessdata directory not found: /repo/resources/tesseract/tessdata',
            'pdftoppm not found: pdftoppm (install Poppler or bundle it)',
            'pdftotext not found: pdftotext (install Poppler or bundle it)',
            'qpdf not found: qpdf (install qpdf or bundle it)',
        ]));
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith('which', ['tesseract'], expect.any(Object));
    });

    it('rejects empty or unreadable tessdata language directories', async () => {
        mocks.readdirSync.mockReturnValue([]);
        const { validateOcrTools } = await import('@electron/ocr/paths');

        await expect(validateOcrTools()).resolves.toMatchObject({
            valid: false,
            tools: {tessdata: {
                found: true,
                path: '/repo/resources/tesseract/tessdata',
                languages: [],
            }},
            errors: expect.arrayContaining(['No language models found in tessdata: /repo/resources/tesseract/tessdata']),
        });

        vi.resetModules();
        mocks.readdirSync.mockImplementation(() => {
            throw new Error('permission denied');
        });
        const fresh = await import('@electron/ocr/paths');
        await expect(fresh.validateOcrTools()).resolves.toMatchObject({
            valid: false,
            tools: {tessdata: {
                found: true,
                path: '/repo/resources/tesseract/tessdata',
                languages: [],
            }},
        });
    });

    it('rejects tessdata directories missing canonical registry languages', async () => {
        mocks.readdirSync.mockReturnValue([
            'eng.traineddata',
            'fra.traineddata',
        ]);
        const { validateOcrTools } = await import('@electron/ocr/paths');

        const result = await validateOcrTools();

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual(expect.stringContaining('Missing registry language models in tessdata:'));
        expect(result.errors.join('\n')).toContain('ara');
        expect(result.errors.join('\n')).toContain('tur');
    });
});
