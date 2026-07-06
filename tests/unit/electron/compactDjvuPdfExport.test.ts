import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
} from 'node:path';
import { tmpdir } from 'node:os';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    getDjvuNativeToolPaths: vi.fn(),
    renderDjvuPageToImage: vi.fn(),
    runNativeCommand: vi.fn(),
    runRegisteredDjvuProcess: vi.fn(),
    resolveNativeToolPath: vi.fn(),
}));

vi.mock('electron', () => ({app: {isPackaged: false}}));
vi.mock('@electron/djvu/nativeToolPaths', () => ({getDjvuNativeToolPaths: mocks.getDjvuNativeToolPaths}));
vi.mock('@electron/djvu/paths', () => ({buildDjvuRuntimeEnv: () => ({})}));
vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({
    renderDjvuPageToImage: mocks.renderDjvuPageToImage,
    runRegisteredDjvuProcess: mocks.runRegisteredDjvuProcess,
}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: mocks.resolveNativeToolPath}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const { buildCompactDjvuAwarePdfFromDjvu } = await import('@electron/features/djvu/main/buildCompactDjvuAwarePdfFromDjvu');

interface ITestDumpPage {
    pageNumber: number;
    pageBytes?: number;
    maskBytes?: number | null;
    background?: boolean;
    foreground?: boolean;
}

describe('buildCompactDjvuAwarePdfFromDjvu', () => {
    let tempDir: string;
    let detailedBackgroundPages: Set<number>;
    let coloredForegroundPages: Set<number>;
    let denseMaskPages: Set<number>;

    beforeEach(async () => {
        vi.clearAllMocks();
        detailedBackgroundPages = new Set();
        coloredForegroundPages = new Set();
        denseMaskPages = new Set();
        tempDir = await mkdtemp(join(tmpdir(), 'compact-djvu-export-test-'));
        mocks.getDjvuNativeToolPaths.mockReturnValue({
            ddjvu: '/tools/ddjvu',
            djvudump: '/tools/djvudump',
            djvused: '/tools/djvused',
        });
        setDjvuDump(Array.from({length: 44}, (_value, index) => ({
            pageNumber: index + 1,
            pageBytes: 32_705,
            maskBytes: 512,
            background: true,
        })));
        mocks.resolveNativeToolPath.mockReturnValue('/native/evb-pdf-image-combine');
        mocks.runRegisteredDjvuProcess.mockImplementation(async (
            _processId: string,
            _command: string,
            args: string[],
            options?: { onStdout?: (chunk: string) => void },
        ) => {
            options?.onStdout?.('{"type":"progress","processed":1,"total":1,"percent":100,"elapsedMs":1,"estimatedRemainingMs":0}\n');
            const outputPath = args[args.indexOf('--output') + 1]!;
            await writeFile(outputPath, '%PDF-1.4\n%%EOF\n', 'utf8');
            return {success: true};
        });
        mocks.renderDjvuPageToImage.mockImplementation(async (
            _inputPath: string,
            outputPath: string,
            pageNumber: number,
            _jobId: string,
            options: {
                mode?: string;
                format?: string;
            } = {},
        ) => {
            await mkdir(dirname(outputPath), {recursive: true});
            if (options.mode === 'foreground') {
                await writeFile(outputPath, coloredForegroundPages.has(pageNumber)
                    ? coloredForegroundProbe()
                    : monochromeForegroundProbe());
            } else if (options.mode === 'background') {
                await writeFile(outputPath, detailedBackgroundPages.has(pageNumber)
                    ? detailedBackgroundProbe()
                    : ppm(2, 2, [
                        248,
                        248,
                        248,
                    ]));
            } else if (options.mode === 'mask') {
                await writeFile(outputPath, denseMaskPages.has(pageNumber)
                    ? pbm(20, 20, x => x < 16)
                    : pbm(20, 20));
            } else {
                await writeFile(outputPath, ppm(5, 5, [
                    220,
                    221,
                    222,
                ]));
            }
            return {
                success: true,
                outputPath,
                fileSize: 12,
            };
        });
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    });

    it('uses bitonal mask output for native masks over a flat background', async () => {
        const progress = vi.fn();

        const result = await buildCompactDjvuAwarePdfFromDjvu({
            jobId: 'job-flat',
            djvuPath: '/input.djvu',
            outputPath: join(tempDir, 'output.pdf'),
            tempDir,
            pageCount: 44,
            sourceDpi: 300,
            pageSizes: pageSizes(44),
            pages: [
                1,
                44,
            ],
            onProgress: progress,
        });

        expect(result.success).toBe(true);
        const manifest = await readFile(join(tempDir, 'compact-manifest.tsv'), 'utf8');
        const lines = manifest.trim().split('\n');
        expect(lines[0]).toMatch(/^mask\t288\.0000\t384\.0000\t/u);
        expect(lines[0]).toContain('-mask.pbm');
        expect(lines[1]).toMatch(/^mask\t288\.0000\t384\.0000\t/u);
        expect(renderModesForPage(1)).toEqual([
            'mask',
            'background',
        ]);
        expect(renderModesForPage(44)).toEqual([
            'mask',
            'background',
        ]);
        expect(progress).toHaveBeenCalled();
    });

    it('uses layered JPEG output at the native background subsample', async () => {
        detailedBackgroundPages.add(44);

        await buildCompactDjvuAwarePdfFromDjvu({
            jobId: 'job-layered',
            djvuPath: '/input.djvu',
            outputPath: join(tempDir, 'layered.pdf'),
            tempDir,
            pageCount: 44,
            sourceDpi: 300,
            pageSizes: pageSizes(44),
            pages: [44],
        });

        const manifest = await readFile(join(tempDir, 'compact-manifest.tsv'), 'utf8');
        expect(manifest).toMatch(/^layered-jpeg\t288\.0000\t384\.0000\t80\t/u);
        expect(manifest).toContain('-background.ppm\t');
        expect(manifest).toContain('-mask.pbm');
        expect(renderModesForPage(44)).toEqual([
            'mask',
            'background',
        ]);
        expect(renderOptionsForPage(44)[1]).toEqual(expect.objectContaining({
            mode: 'background',
            subsample: 3,
        }));
    });

    it('uses layered-color output when the native foreground layer has real color', async () => {
        setDjvuDump([{
            pageNumber: 3,
            pageBytes: 65_000,
            maskBytes: 512,
            background: true,
            foreground: true,
        }]);
        detailedBackgroundPages.add(3);
        coloredForegroundPages.add(3);

        const result = await buildCompactDjvuAwarePdfFromDjvu({
            jobId: 'job-color',
            djvuPath: '/input.djvu',
            outputPath: join(tempDir, 'colored.pdf'),
            tempDir,
            pageCount: 3,
            sourceDpi: 300,
            pageSizes: pageSizes(3),
            pages: [3],
        });

        const manifest = await readFile(join(tempDir, 'compact-manifest.tsv'), 'utf8');
        expect(manifest).toMatch(/^layered-color-jpeg\t288\.0000\t384\.0000\t80\t/u);
        expect(manifest).toContain('-background.ppm\t');
        expect(manifest).toMatch(/-mask\.pbm\t220\t20\t20\n$/u);
        expect(manifest).not.toContain('-foreground.ppm');
        expect(result.pageSpecs?.[0]?.kind).toBe('layered-color');
        expect(renderModesForPage(3)).toEqual([
            'mask',
            'background',
            'foreground',
        ]);
    });

    it('uses capped photo output for tiny-mask continuous-tone pages', async () => {
        setDjvuDump([{
            pageNumber: 44,
            pageBytes: 32_705,
            maskBytes: 6,
            background: true,
            foreground: true,
        }]);

        const result = await buildCompactDjvuAwarePdfFromDjvu({
            jobId: 'job-photo',
            djvuPath: '/input.djvu',
            outputPath: join(tempDir, 'photo.pdf'),
            tempDir,
            pageCount: 44,
            sourceDpi: 300,
            pageSizes: pageSizes(44),
            pages: [44],
        });

        const manifest = await readFile(join(tempDir, 'compact-manifest.tsv'), 'utf8');
        expect(manifest).toMatch(/^photo-jpeg\t288\.0000\t384\.0000\t85\t300\t/u);
        expect(result.pageSpecs?.[0]?.kind).toBe('photo');
        expect(result.pageSpecs?.[0]?.reason).toBe('DjVu page has continuous-tone background with tiny foreground mask (6 bytes); rendering capped photo page');
        expect(renderModesForPage(44)).toEqual(['full']);
        expect(renderOptionsForPage(44)[0]).toEqual(expect.objectContaining({
            targetHeightPx: 1600,
            targetWidthPx: 1200,
        }));
    });

    it('uses capped photo output when djvudump structure is unavailable', async () => {
        setDjvuDump([]);

        const result = await buildCompactDjvuAwarePdfFromDjvu({
            jobId: 'job-no-structure',
            djvuPath: '/input.djvu',
            outputPath: join(tempDir, 'no-structure.pdf'),
            tempDir,
            pageCount: 2,
            sourceDpi: 300,
            pageSizes: pageSizes(2),
            pages: [2],
        });

        const manifest = await readFile(join(tempDir, 'compact-manifest.tsv'), 'utf8');
        expect(manifest).toMatch(/^photo-jpeg\t288\.0000\t384\.0000\t85\t300\t/u);
        expect(result.pageSpecs?.[0]?.reason).toBe('DjVu layer structure unavailable; rendering capped photo page');
        expect(renderModesForPage(2)).toEqual(['full']);
        expect(renderOptionsForPage(2)[0]).toEqual(expect.objectContaining({
            targetHeightPx: 1600,
            targetWidthPx: 1200,
        }));
    });

    it('does not force dense real masks into photo fallback', async () => {
        detailedBackgroundPages.add(44);
        denseMaskPages.add(44);

        const result = await buildCompactDjvuAwarePdfFromDjvu({
            jobId: 'job-dense-mask',
            djvuPath: '/input.djvu',
            outputPath: join(tempDir, 'dense-mask.pdf'),
            tempDir,
            pageCount: 44,
            sourceDpi: 300,
            pageSizes: pageSizes(44),
            pages: [44],
        });

        const manifest = await readFile(join(tempDir, 'compact-manifest.tsv'), 'utf8');
        expect(manifest).toMatch(/^layered-jpeg\t288\.0000\t384\.0000\t80\t/u);
        expect(result.pageSpecs?.[0]?.kind).toBe('layered');
        expect(renderModesForPage(44)).toEqual([
            'mask',
            'background',
        ]);
    });

    it('does not retry with photo rendering after a canceled layered render', async () => {
        const abortController = new AbortController();
        detailedBackgroundPages.add(44);
        mocks.renderDjvuPageToImage.mockImplementation(async (
            _inputPath: string,
            outputPath: string,
            _pageNumber: number,
            _jobId: string,
            options: {
                mode?: string;
                format?: string;
            } = {},
        ) => {
            await mkdir(dirname(outputPath), {recursive: true});
            if (options.mode === 'mask') {
                await writeFile(outputPath, pbm(20, 20));
                return {
                    success: true,
                    outputPath,
                    fileSize: 12,
                };
            }
            if (options.mode === 'background') {
                abortController.abort();
                return {
                    success: false,
                    outputPath,
                    fileSize: 0,
                    error: 'DjVu conversion canceled',
                };
            }
            throw new Error(`Unexpected render mode after cancellation: ${options.mode ?? 'full'}`);
        });

        await expect(buildCompactDjvuAwarePdfFromDjvu({
            jobId: 'job-canceled',
            djvuPath: '/input.djvu',
            outputPath: join(tempDir, 'canceled.pdf'),
            tempDir,
            pageCount: 44,
            sourceDpi: 300,
            pageSizes: pageSizes(44),
            pages: [44],
            signal: abortController.signal,
        })).rejects.toThrow('DjVu conversion canceled');

        expect(renderModesForPage(44)).toEqual([
            'mask',
            'background',
        ]);
        expect(mocks.runRegisteredDjvuProcess).not.toHaveBeenCalled();
    });
});

function setDjvuDump(pages: ITestDumpPage[]) {
    mocks.runNativeCommand.mockResolvedValue({
        stdout: djvuDump(pages),
        stderr: '',
        exitCode: 0,
    });
}

function djvuDump(pages: ITestDumpPage[]) {
    return [
        '  FORM:DJVM [14712301]',
        ...pages.flatMap(page => {
            const lines = [
                `    FORM:DJVU [${page.pageBytes ?? 32705}] {p${String(page.pageNumber).padStart(4, '0')}.djvu} [P${page.pageNumber}] (${page.pageNumber})`,
                '      INFO [10]         DjVu 1200x1600, v24, 300 dpi, gamma=2.2',
            ];
            if (page.maskBytes !== null) {
                lines.push(`      Sjbz [${page.maskBytes ?? 512}]          JB2 bilevel data`);
            }
            if (page.foreground) {
                lines.push('      FG44 [420]        IW4 data #1, 12 slices, v1.2 (color), 100x133');
            }
            if (page.background) {
                lines.push('      BG44 [8674]       IW4 data #1, 72 slices, v1.2 (color), 400x533');
            }
            return lines;
        }),
    ].join('\n');
}

function renderModesForPage(pageNumber: number) {
    return mocks.renderDjvuPageToImage.mock.calls
        .filter(call => call[2] === pageNumber)
        .map(call => (call[4] as { mode?: string }).mode ?? 'full');
}

function renderOptionsForPage(pageNumber: number) {
    return mocks.renderDjvuPageToImage.mock.calls
        .filter(call => call[2] === pageNumber)
        .map(call => call[4] as Record<string, unknown>);
}

function pageSizes(count: number) {
    return Array.from({length: count}, () => ({
        width: 1200,
        height: 1600,
        dpi: 300,
    }));
}

function monochromeForegroundProbe() {
    const width = 20;
    const height = 20;
    const pixels = Array.from({length: width * height}, (_value, index) => (
        index % 97 === 0 ? [
            0,
            0,
            0,
        ] : [
            255,
            255,
            255,
        ]
    )).flat();
    return Buffer.from(`P6\n${width} ${height}\n255\n${String.fromCharCode(...pixels)}`, 'binary');
}

function coloredForegroundProbe() {
    const width = 20;
    const height = 20;
    const pixels = Array.from({length: width * height}, (_value, index) => (
        index % 10 === 0 ? [
            220,
            20,
            20,
        ] : [
            255,
            255,
            255,
        ]
    )).flat();
    return Buffer.from(`P6\n${width} ${height}\n255\n${String.fromCharCode(...pixels)}`, 'binary');
}

function ppm(width: number, height: number, pixel: [number, number, number]) {
    const pixels = Buffer.alloc(width * height * 3);
    for (let offset = 0; offset < pixels.length; offset += 3) {
        pixels[offset] = pixel[0];
        pixels[offset + 1] = pixel[1];
        pixels[offset + 2] = pixel[2];
    }
    return Buffer.concat([
        Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'),
        pixels,
    ]);
}

function detailedBackgroundProbe() {
    return Buffer.concat([
        Buffer.from('P6\n2 2\n255\n', 'ascii'),
        Buffer.from([
            40,
            40,
            40,
            250,
            250,
            250,
            120,
            120,
            120,
            220,
            210,
            190,
        ]),
    ]);
}

function pbm(
    width: number,
    height: number,
    isBlack: (x: number, y: number) => boolean = (x, y) => x === 0 && y === 0,
) {
    const rowStride = Math.ceil(width / 8);
    const pixels = Buffer.alloc(rowStride * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (isBlack(x, y)) {
                pixels[y * rowStride + Math.floor(x / 8)]! |= 0x80 >> (x % 8);
            }
        }
    }
    return Buffer.concat([
        Buffer.from(`P4\n${width} ${height}\n`, 'ascii'),
        pixels,
    ]);
}
