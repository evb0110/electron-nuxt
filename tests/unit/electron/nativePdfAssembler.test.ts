import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IMockNativeWriteProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface IMockNativeWriteOptions {
    maxPages?: number;
    onProgress?: (progress: IMockNativeWriteProgress) => void;
    signal?: AbortSignal;
}

interface IMockDjvuConvertSuccess {
    success: true;
    outputPath: string;
    fileSize: number;
}

const mocks = vi.hoisted(() => {
    const atomicReplace = vi.fn(async (_sourcePath: string, _targetPath: string) => undefined);
    const copyFile = vi.fn(async () => undefined);
    const makeSiblingTempPath = vi.fn((targetPath: string) => `${targetPath}.tmp`);
    const mkdtemp = vi.fn(async () => '/tmp/native-assembler');
    const readFile = vi.fn(async (path: string) => new Uint8Array(path.endsWith('input.pdf')
        ? [
            1,
            1,
            1,
        ]
        : [
            8,
            8,
            8,
        ]));
    const rm = vi.fn(async () => undefined);
    const stat = vi.fn(async () => ({size: 3}));
    const runQpdfCommand = vi.fn(async () => undefined);
    const assertNonEmptyPdfOutput = vi.fn(async () => undefined);
    const getPdfPageCount = vi.fn(async (path: string): Promise<number> => path.includes('/image-chunk-') ? 3 : 1);
    const getDjvuPageCount = vi.fn(async () => 2);
    const nativeWrite = vi.fn(async (
        inputPaths: string[],
        _outputPath: string,
        options?: IMockNativeWriteOptions,
    ) => {
        options?.onProgress?.({
            processed: inputPaths.length,
            total: inputPaths.length,
            percent: 100,
            elapsedMs: 1,
            estimatedRemainingMs: 0,
        });
        return true;
    });
    const convertDjvuToPdfFile = vi.fn(async (
        _inputPath: string,
        _outputPath: string,
        _jobId: string,
        _options?: unknown,
    ): Promise<IMockDjvuConvertSuccess> => ({
        success: true,
        outputPath: '/tmp/native-assembler/djvu-chunk.pdf',
        fileSize: 1024,
    }));
    const cancelConversion = vi.fn(async () => true);
    const warn = vi.fn();

    return {
        atomicReplace,
        copyFile,
        makeSiblingTempPath,
        mkdtemp,
        readFile,
        rm,
        stat,
        runQpdfCommand,
        assertNonEmptyPdfOutput,
        getPdfPageCount,
        getDjvuPageCount,
        nativeWrite,
        convertDjvuToPdfFile,
        cancelConversion,
        warn,
    };
});

vi.mock('fs/promises', () => ({
    copyFile: mocks.copyFile,
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: [string, string]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));

vi.mock('@electron/features/page-ops/public', () => ({
    assertNonEmptyPdfOutput: mocks.assertNonEmptyPdfOutput,
    getPdfPageCount: mocks.getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES: [
        0,
        3,
    ],
    QPDF_TIMEOUT_MS: 120_000,
    runQpdfCommand: mocks.runQpdfCommand,
}));

vi.mock('@electron/features/djvu/public', () => ({
    cancelConversion: mocks.cancelConversion,
    convertDjvuToPdfFile: mocks.convertDjvuToPdfFile,
}));
vi.mock('@electron/djvu/metadata', () => ({getDjvuPageCount: mocks.getDjvuPageCount}));

vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({
    isNativePdfImageCombineBitmapPath: (inputPath: string) => /\.(?:png|jpe?g|tiff?)$/iu.test(inputPath),
    tryWritePdfWithNativeImageCombiner: (
        inputPaths: string[],
        outputPath: string,
        options?: Parameters<typeof mocks.nativeWrite>[2],
    ) => mocks.nativeWrite(inputPaths, outputPath, options),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    warn: mocks.warn,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
})}));

const {
    tryCreatePdfFromInputPathsNative,
    tryWritePdfFromInputPathsNative,
} = await import('@electron/image/tryCreatePdfFromInputPathsNative');

describe('tryCreatePdfFromInputPathsNative', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('VITEST', 'true');
        mocks.getDjvuPageCount.mockResolvedValue(2);
        mocks.cancelConversion.mockResolvedValue(true);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('is disabled by default in Vitest', async () => {
        const result = await tryCreatePdfFromInputPathsNative(['/tmp/input.pdf']);

        expect(result).toBeNull();
        expect(mocks.mkdtemp).not.toHaveBeenCalled();
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
    });

    it('groups native image chunks and merges them with PDFs and converted DjVu files', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        const progress = vi.fn();

        const result = await tryCreatePdfFromInputPathsNative([
            '/tmp/a.pdf',
            '/tmp/one.png',
            '/tmp/two.jpg',
            '/tmp/three.tiff',
            '/tmp/scan.djvu',
            '/tmp/b.pdf',
        ], {onProgress: progress});

        expect(Array.from(result ?? [])).toEqual([
            8,
            8,
            8,
        ]);
        expect(mocks.nativeWrite).toHaveBeenCalledWith([
            '/tmp/one.png',
            '/tmp/two.jpg',
            '/tmp/three.tiff',
        ], expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u), expect.any(Object));
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledWith(
            '/tmp/scan.djvu',
            expect.stringMatching(/^\/tmp\/native-assembler\/djvu-chunk-.+\.pdf$/u),
            expect.stringMatching(/^pdf-native-assembler-djvu-/u),
            {
                subsample: 1,
                pageCount: 2,
            },
        );
        expect(mocks.runQpdfCommand).toHaveBeenCalledWith([
            '--empty',
            '--pages',
            '/tmp/a.pdf',
            expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u),
            expect.stringMatching(/^\/tmp\/native-assembler\/djvu-chunk-.+\.pdf$/u),
            '/tmp/b.pdf',
            '--',
            expect.stringMatching(/^\/tmp\/native-assembler\/.+\.pdf$/u),
        ], expect.objectContaining({
            allowedExitCodes: [
                0,
                3,
            ],
            commandLabel: 'qpdf(native-pdf-assembler)',
            timeoutMs: 120_000,
        }));
        expect(mocks.getPdfPageCount).toHaveBeenCalledWith('/tmp/a.pdf', expect.any(Object));
        expect(mocks.getPdfPageCount).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/native-assembler\/djvu-chunk-.+\.pdf$/u), expect.any(Object));
        expect(mocks.readFile).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/native-assembler\/.+\.pdf$/u));
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/native-assembler', {
            recursive: true,
            force: true,
        });
        expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
            processed: 6,
            total: 6,
            percent: 100,
        }));
    });

    it('writes native assembly to the requested output path without reading the output into memory', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');

        const ok = await tryWritePdfFromInputPathsNative([
            '/tmp/a.pdf',
            '/tmp/one.png',
        ], '/tmp/final.pdf');

        expect(ok).toBe(true);
        expect(mocks.nativeWrite).toHaveBeenCalledWith(
            ['/tmp/one.png'],
            expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u),
            expect.any(Object),
        );
        expect(mocks.runQpdfCommand).toHaveBeenCalledWith([
            '--empty',
            '--pages',
            '/tmp/a.pdf',
            expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u),
            '--',
            '/tmp/final.pdf.tmp',
        ], expect.objectContaining({commandLabel: 'qpdf(native-pdf-assembler)'}));
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/final.pdf.tmp', '/tmp/final.pdf');
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/native-assembler', {
            recursive: true,
            force: true,
        });
    });

    it('allows file-backed native assembly beyond the in-memory page cap', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        mocks.getPdfPageCount.mockImplementation(async (path: string) => {
            if (path === '/tmp/large.pdf') {
                return 501;
            }
            return path.includes('/image-chunk-') ? 3 : 1;
        });

        const ok = await tryWritePdfFromInputPathsNative([
            '/tmp/large.pdf',
            '/tmp/one.png',
        ], '/tmp/final.pdf');

        expect(ok).toBe(true);
        expect(mocks.nativeWrite).toHaveBeenCalledWith(
            ['/tmp/one.png'],
            expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u),
            expect.objectContaining({maxPages: 10_000}),
        );
        expect(mocks.runQpdfCommand).toHaveBeenCalledWith([
            '--empty',
            '--pages',
            '/tmp/large.pdf',
            expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u),
            '--',
            '/tmp/final.pdf.tmp',
        ], expect.objectContaining({commandLabel: 'qpdf(native-pdf-assembler)'}));
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/final.pdf.tmp', '/tmp/final.pdf');
        expect(mocks.warn).not.toHaveBeenCalled();
    });

    it('keeps memory-returning native assembly capped at 500 pages by default', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        mocks.getPdfPageCount.mockResolvedValueOnce(501);

        const result = await tryCreatePdfFromInputPathsNative(['/tmp/large.pdf']);

        expect(result).toBeNull();
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('Combined PDF is capped at 500 pages'));
    });

    it('cancels the generated DjVu chunk job when native assembly aborts', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        const controller = new AbortController();
        let resolveConversion: (value: IMockDjvuConvertSuccess) => void = () => {};
        mocks.convertDjvuToPdfFile.mockImplementationOnce(async () => new Promise<IMockDjvuConvertSuccess>((resolve) => {
            resolveConversion = resolve;
        }));

        const assemblePromise = tryCreatePdfFromInputPathsNative(['/tmp/scan.djvu'], {signal: controller.signal});
        for (let attempt = 0; attempt < 20 && mocks.convertDjvuToPdfFile.mock.calls.length === 0; attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        const jobId = mocks.convertDjvuToPdfFile.mock.calls[0]?.[2];
        expect(jobId).toEqual(expect.stringMatching(/^pdf-native-assembler-djvu-/u));

        controller.abort(new Error('native combine canceled'));
        expect(mocks.cancelConversion).toHaveBeenCalledWith(jobId);
        resolveConversion({
            success: true,
            outputPath: '/tmp/native-assembler/djvu-chunk.pdf',
            fileSize: 1024,
        });

        await expect(assemblePromise).rejects.toThrow('native combine canceled');
        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('copies a single native output chunk to the requested output path', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');

        const ok = await tryWritePdfFromInputPathsNative([
            '/tmp/one.png',
            '/tmp/two.jpg',
        ], '/tmp/final.pdf');

        expect(ok).toBe(true);
        expect(mocks.copyFile).toHaveBeenCalledWith(
            expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u),
            '/tmp/final.pdf.tmp',
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/final.pdf.tmp', '/tmp/final.pdf');
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('leaves the requested output untouched when native file assembly falls back', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        mocks.runQpdfCommand.mockRejectedValueOnce(new Error('qpdf failed midway'));

        const ok = await tryWritePdfFromInputPathsNative([
            '/tmp/a.pdf',
            '/tmp/b.pdf',
        ], '/tmp/final.pdf');

        expect(ok).toBe(false);
        expect(mocks.runQpdfCommand).toHaveBeenCalledWith([
            '--empty',
            '--pages',
            '/tmp/a.pdf',
            '/tmp/b.pdf',
            '--',
            '/tmp/final.pdf.tmp',
        ], expect.objectContaining({commandLabel: 'qpdf(native-pdf-assembler)'}));
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/final.pdf.tmp', { force: true });
    });

    it('falls back when the native image writer is unavailable', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        mocks.nativeWrite.mockResolvedValueOnce(false);

        const result = await tryCreatePdfFromInputPathsNative([
            '/tmp/one.png',
            '/tmp/a.pdf',
        ]);

        expect(result).toBeNull();
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/native-assembler', {
            recursive: true,
            force: true,
        });
    });

    it('keeps pure image jobs on the native image combiner without qpdf page counting', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');

        const result = await tryCreatePdfFromInputPathsNative([
            '/tmp/one.png',
            '/tmp/two.jpg',
            '/tmp/three.tiff',
        ]);

        expect(Array.from(result ?? [])).toEqual([
            8,
            8,
            8,
        ]);
        expect(mocks.nativeWrite).toHaveBeenCalledWith([
            '/tmp/one.png',
            '/tmp/two.jpg',
            '/tmp/three.tiff',
        ], expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u), expect.any(Object));
        expect(mocks.getPdfPageCount).not.toHaveBeenCalled();
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
    });

    it('falls back before creating temp files for image formats outside the native assembler boundary', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');

        const result = await tryCreatePdfFromInputPathsNative([
            '/tmp/a.pdf',
            '/tmp/poster.bmp',
        ]);

        expect(result).toBeNull();
        expect(mocks.mkdtemp).not.toHaveBeenCalled();
        expect(mocks.nativeWrite).not.toHaveBeenCalled();
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
    });

    it('falls back when mixed inputs exceed the shared PDF page cap', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        vi.stubEnv('EVB_PDF_COMBINE_MAX_PAGES', '3');

        const result = await tryCreatePdfFromInputPathsNative([
            '/tmp/a.pdf',
            '/tmp/three.tiff',
        ]);

        expect(result).toBeNull();
        expect(mocks.nativeWrite).toHaveBeenCalledWith(
            ['/tmp/three.tiff'],
            expect.any(String),
            expect.any(Object),
        );
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('Combined PDF is capped at 3 pages'));
    });

    it('preserves the shared page cap precheck for pure image native jobs', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        vi.stubEnv('EVB_PDF_COMBINE_MAX_PAGES', '2');

        const result = await tryCreatePdfFromInputPathsNative([
            '/tmp/one.png',
            '/tmp/two.jpg',
            '/tmp/three.tiff',
        ]);

        expect(result).toBeNull();
        expect(mocks.nativeWrite).not.toHaveBeenCalled();
        expect(mocks.getPdfPageCount).not.toHaveBeenCalled();
        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('Combined PDF is capped at 2 pages'));
    });

    it('falls back when native assembler output exceeds the shared output byte cap', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        vi.stubEnv('EVB_PDF_COMBINE_MAX_OUTPUT_MB', '1');
        mocks.stat.mockResolvedValueOnce({size: (1024 * 1024) + 1});

        const result = await tryCreatePdfFromInputPathsNative([
            '/tmp/a.pdf',
            '/tmp/one.png',
        ]);

        expect(result).toBeNull();
        expect(mocks.runQpdfCommand).toHaveBeenCalledTimes(1);
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('Combined PDF output is too large to return safely'));
    });
});
