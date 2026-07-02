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
        encode: vi.fn(() => new Uint8Array([
            9,
            9,
        ])),
        getDjvuResolution: vi.fn(async () => 300),
        mkdtemp: vi.fn(async () => '/tmp/djvu-preview-test'),
        readFile: vi.fn(async () => tinyPpm),
        rm: vi.fn(async () => undefined),
        runNativeCommand: vi.fn(async () => ({
            stdout: '100 200',
            stderr: '',
            exitCode: 0,
        })),
        stat: vi.fn(async () => ({
            isFile: () => true,
            size: tinyPpm.byteLength,
        })),
    };
});

vi.mock('fast-png', () => ({encode: mocks.encode}));
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
vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({convertDjvuPageToImage: mocks.convertDjvuPageToImage}));

const {
    parseDjvuPageSizeOutput,
    renderDjvuPagePreview,
} = await import('@electron/features/djvu/main/pagePreview');

describe('DjVu native page preview helpers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.convertDjvuPageToImage.mockResolvedValue({
            success: true,
            outputPath: '/tmp/djvu-preview-test/page.ppm',
            fileSize: 12,
        });
        mocks.getDjvuResolution.mockResolvedValue(300);
        mocks.mkdtemp.mockResolvedValue('/tmp/djvu-preview-test');
        mocks.readFile.mockResolvedValue(mocks.tinyPpm);
        mocks.runNativeCommand.mockResolvedValue({
            stdout: '100 200',
            stderr: '',
            exitCode: 0,
        });
        mocks.stat.mockResolvedValue({
            isFile: () => true,
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

    it('rejects oversized PPM output before reading it into memory', async () => {
        mocks.stat.mockResolvedValueOnce({
            isFile: () => true,
            size: 193 * 1024 * 1024,
        });

        await expect(renderDjvuPagePreview('/tmp/book.djvu', 1, {subsample: 4}))
            .rejects
            .toThrow('DjVu preview output exceeds safe read limit (192MB)');

        expect(mocks.readFile).not.toHaveBeenCalled();
    });
});
