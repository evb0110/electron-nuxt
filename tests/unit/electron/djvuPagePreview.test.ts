import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const tinyPpm = Buffer.from('P6\n1 1\n255\n\x00\x00\x00', 'binary');
    return {
        tinyPpm,
        convertDjvuPageToImage: vi.fn(async (_inputPath: string, outputPath: string) => ({
            success: true,
            outputPath,
            fileSize: 12,
        })),
        probeNativeNetpbm: vi.fn<() => Promise<{
            width: number;
            height: number;
            channels: number;
        } | null>>(async () => ({
            width: 1,
            height: 1,
            channels: 3,
        })),
        runNativeToolCommand: vi.fn(async () => undefined),
        getDjvuResolution: vi.fn(async () => 300),
        mkdtemp: vi.fn(async () => '/tmp/djvu-preview-test'),
        readFile: vi.fn(async () => tinyPpm),
        rm: vi.fn(async () => undefined),
        runNativeCommand: vi.fn(async () => ({
            stdout: '100 200',
            stderr: '',
            exitCode: 0,
        })),
        stat: vi.fn(async (_path?: string) => ({
            isFile: () => true,
            mtimeMs: 1,
            size: tinyPpm.byteLength,
        })),
    };
});

vi.mock('fs/promises', () => ({
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
}));
vi.mock('@electron/djvu/metadata', () => ({getDjvuResolution: mocks.getDjvuResolution}));
vi.mock('@electron/djvu/nativeToolPaths', () => ({getDjvuNativeToolPaths: () => ({djvused: '/tools/djvused'})}));
vi.mock('@electron/djvu/paths', () => ({buildDjvuRuntimeEnv: () => ({DJVU: '1'})}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runNativeToolCommand}));
vi.mock('@electron/features/djvu/main/probeNativeNetpbm', () => ({probeNativeNetpbm: mocks.probeNativeNetpbm}));
vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({
    isNativePdfImageCombineDisabled: () => false,
    resolveNativePdfImageCombinePath: () => '/tools/evb-pdf-image-combine',
}));
vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({convertDjvuPageToImage: mocks.convertDjvuPageToImage}));

const {
    clearDjvuPageSizeCacheForTests,
    getDjvuPageSizesForViewing,
    parseDjvuPageSizeOutput,
    renderDjvuPagePreview,
} = await import('@electron/features/djvu/main/pagePreview');

describe('DjVu native page preview helpers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearDjvuPageSizeCacheForTests();
        mocks.convertDjvuPageToImage.mockResolvedValue({
            success: true,
            outputPath: '/tmp/djvu-preview-test/page.ppm',
            fileSize: 12,
        });
        mocks.getDjvuResolution.mockResolvedValue(300);
        mocks.mkdtemp.mockResolvedValue('/tmp/djvu-preview-test');
        mocks.readFile.mockResolvedValue(mocks.tinyPpm);
        mocks.probeNativeNetpbm.mockResolvedValue({
            width: 1,
            height: 1,
            channels: 3,
        });
        mocks.runNativeToolCommand.mockResolvedValue(undefined);
        mocks.runNativeCommand.mockResolvedValue({
            stdout: '100 200',
            stderr: '',
            exitCode: 0,
        });
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            mtimeMs: 1,
            size: mocks.tinyPpm.byteLength,
        });
    });

    it('parses djvused page size output variants', () => {
        expect(parseDjvuPageSizeOutput([
            'width=640 height=480',
            '800x600',
            '1024 768',
            'not a size',
        ].join('\n'), 300)).toEqual([
            {
                width: 640,
                height: 480,
                dpi: 300,
            },
            {
                width: 800,
                height: 600,
                dpi: 300,
            },
            {
                width: 1024,
                height: 768,
                dpi: 300,
            },
        ]);
    });

    it('raises unsafe full-resolution preview requests to the minimum subsample floor', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            stdout: '10000 10000',
            stderr: '',
            exitCode: 0,
        });

        await renderDjvuPagePreview('/tmp/book.djvu', 1, {subsample: 1});

        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.stringMatching(/^\/tmp\/djvu-preview-test\/page-1-.+\.ppm$/u),
            1,
            expect.stringMatching(/^djvu-preview-page-1-/u),
            {
                format: 'ppm',
                subsample: 2,
            },
        );
    });

    it('ignores over-native target size for native ddjvu previews', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            stdout: '1293 1966',
            stderr: '',
            exitCode: 0,
        });

        await renderDjvuPagePreview('/tmp/book.djvu', 1, { targetWidthPx: 2484 });

        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.stringMatching(/^\/tmp\/djvu-preview-test\/page-1-.+\.ppm$/u),
            1,
            expect.stringMatching(/^djvu-preview-page-1-/u),
            {format: 'ppm'},
        );
    });

    it('downsamples viewport previews in ddjvu instead of decoding archival resolution', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            stdout: '1293 1966',
            stderr: '',
            exitCode: 0,
        });

        await renderDjvuPagePreview('/tmp/book.djvu', 1, {targetWidthPx: 400});

        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.stringMatching(/^\/tmp\/djvu-preview-test\/page-1-.+\.ppm$/u),
            1,
            expect.stringMatching(/^djvu-preview-page-1-/u),
            {
                format: 'ppm',
                targetHeightPx: 608,
                targetWidthPx: 400,
            },
        );
    });

    it('reuses the page metrics loaded at open instead of spawning a size probe per preview', async () => {
        mocks.runNativeCommand.mockResolvedValue({
            stdout: '1293 1966',
            stderr: '',
            exitCode: 0,
        });
        await getDjvuPageSizesForViewing('/tmp/book.djvu', 1);

        await renderDjvuPagePreview('/tmp/book.djvu', 1, {targetWidthPx: 400});

        expect(mocks.runNativeCommand).toHaveBeenCalledOnce();
        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.any(String),
            1,
            expect.any(String),
            expect.objectContaining({
                targetHeightPx: 608,
                targetWidthPx: 400,
            }),
        );
    });

    it('invalidates cached page metrics when the file revision changes at the same path', async () => {
        mocks.stat
            .mockResolvedValueOnce({
                isFile: () => true,
                mtimeMs: 1,
                size: 100,
            })
            .mockResolvedValueOnce({
                isFile: () => true,
                mtimeMs: 2,
                size: 101,
            });
        mocks.runNativeCommand
            .mockResolvedValueOnce({
                stdout: '100 200',
                stderr: '',
                exitCode: 0,
            })
            .mockResolvedValueOnce({
                stdout: '300 400',
                stderr: '',
                exitCode: 0,
            });

        await getDjvuPageSizesForViewing('/tmp/reused.djvu', 1);
        await renderDjvuPagePreview('/tmp/reused.djvu', 1, {targetWidthPx: 150});

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(2);
        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/reused.djvu',
            expect.any(String),
            1,
            expect.any(String),
            expect.objectContaining({targetHeightPx: 200}),
        );
    });

    it('rejects oversized PPM output before reading it into memory', async () => {
        mocks.stat.mockImplementation(async (path?: string) => ({
            isFile: () => true as const,
            mtimeMs: 1,
            size: path?.endsWith('.ppm') === true
                ? 193 * 1024 * 1024
                : mocks.tinyPpm.byteLength,
        }));

        await expect(renderDjvuPagePreview('/tmp/book.djvu', 1, {subsample: 4}))
            .rejects
            .toThrow('DjVu preview output exceeds safe read limit (192MB)');

        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('fails recoverably instead of decoding a large Netpbm buffer in the main process', async () => {
        mocks.probeNativeNetpbm.mockResolvedValueOnce(null);

        await expect(renderDjvuPagePreview('/tmp/book.djvu', 1, {subsample: 4}))
            .rejects
            .toThrow('large Netpbm fallback is intentionally disabled');

        expect(mocks.readFile).not.toHaveBeenCalled();
    });
});
