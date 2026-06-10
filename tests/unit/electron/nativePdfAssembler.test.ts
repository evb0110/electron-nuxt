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

type TMockNativeWriteOptions = {onProgress?: (progress: IMockNativeWriteProgress) => void};

const mocks = vi.hoisted(() => {
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
    const runQpdfCommand = vi.fn(async () => undefined);
    const assertNonEmptyPdfOutput = vi.fn(async () => undefined);
    const nativeWrite = vi.fn(async (
        inputPaths: string[],
        _outputPath: string,
        options?: TMockNativeWriteOptions,
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
    const convertDjvuToPdfFile = vi.fn(async () => ({
        success: true,
        outputPath: '/tmp/native-assembler/djvu-chunk.pdf',
        fileSize: 1024,
    }));
    const warn = vi.fn();

    return {
        mkdtemp,
        readFile,
        rm,
        runQpdfCommand,
        assertNonEmptyPdfOutput,
        nativeWrite,
        convertDjvuToPdfFile,
        warn,
    };
});

vi.mock('fs/promises', () => ({
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
}));

vi.mock('@electron/features/page-ops/public', () => ({
    assertNonEmptyPdfOutput: mocks.assertNonEmptyPdfOutput,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES: [
        0,
        3,
    ],
    QPDF_TIMEOUT_MS: 120_000,
    runQpdfCommand: mocks.runQpdfCommand,
}));

vi.mock('@electron/features/djvu/public', () => ({convertDjvuToPdfFile: mocks.convertDjvuToPdfFile}));

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

const { tryCreatePdfFromInputPathsNative } = await import('@electron/image/tryCreatePdfFromInputPathsNative');

describe('tryCreatePdfFromInputPathsNative', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('VITEST', 'true');
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
        ], expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u), expect.any(Object));
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledWith(
            '/tmp/scan.djvu',
            expect.stringMatching(/^\/tmp\/native-assembler\/djvu-chunk-.+\.pdf$/u),
            expect.stringMatching(/^pdf-native-assembler-djvu-/u),
            {subsample: 1},
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
        expect(mocks.readFile).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/native-assembler\/.+\.pdf$/u));
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/native-assembler', {
            recursive: true,
            force: true,
        });
        expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
            processed: 5,
            total: 5,
            percent: 100,
        }));
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
});
