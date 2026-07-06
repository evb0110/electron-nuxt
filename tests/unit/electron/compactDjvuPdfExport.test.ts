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
    renderDjvuPageToImage: vi.fn(),
    runRegisteredDjvuProcess: vi.fn(),
    resolveNativeToolPath: vi.fn(),
}));

vi.mock('electron', () => ({app: {isPackaged: false}}));
vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({
    renderDjvuPageToImage: mocks.renderDjvuPageToImage,
    runRegisteredDjvuProcess: mocks.runRegisteredDjvuProcess,
}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: mocks.resolveNativeToolPath}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const { buildCompactDjvuAwarePdfFromDjvu } = await import('@electron/features/djvu/main/buildCompactDjvuAwarePdfFromDjvu');

describe('buildCompactDjvuAwarePdfFromDjvu', () => {
    let tempDir: string;

    beforeEach(async () => {
        vi.clearAllMocks();
        tempDir = await mkdtemp(join(tmpdir(), 'compact-djvu-export-test-'));
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
                format?: string 
            } = {},
        ) => {
            await mkdir(dirname(outputPath), {recursive: true});
            if (options.mode === 'foreground') {
                await writeFile(outputPath, pageNumber === 3 ? coloredForegroundProbe() : monochromeForegroundProbe());
            } else if (options.mode === 'background') {
                await writeFile(outputPath, ppm(2, 2, [
                    248,
                    248,
                    248,
                ]));
            } else if (options.mode === 'mask') {
                await writeFile(outputPath, pbm(20, 20));
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

    it('writes a mixed manifest with front-matter fallback and body-page mask-only output', async () => {
        const progress = vi.fn();

        const result = await buildCompactDjvuAwarePdfFromDjvu({
            jobId: 'job-1',
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
        expect(mocks.runRegisteredDjvuProcess).toHaveBeenCalledWith(
            'job-1-compact-combine',
            '/native/evb-pdf-image-combine',
            expect.arrayContaining([
                '--compact-manifest',
                join(tempDir, 'compact-manifest.tsv'),
            ]),
            expect.objectContaining({
                env: expect.objectContaining({EVB_PDF_COMBINE_MAX_PAGES: '2'}),
                onStdout: expect.any(Function),
            }),
        );
        const manifest = await readFile(join(tempDir, 'compact-manifest.tsv'), 'utf8');
        const lines = manifest.trim().split('\n');
        expect(lines[0]).toMatch(/^image-jpeg\t288\.0000\t384\.0000\t75\t/u);
        expect(lines[1]).toMatch(/^mask\t288\.0000\t384\.0000\t/u);
        expect(lines[1]).toContain('-mask.pbm');
        expect(renderModesForPage(1)).toEqual([
            'foreground',
            'full',
        ]);
        expect(renderModesForPage(44)).toEqual([
            'foreground',
            'mask',
            'background',
        ]);
        expect(progress).toHaveBeenCalled();
    });

    it('falls back when the foreground probe contains color', async () => {
        const result = await buildCompactDjvuAwarePdfFromDjvu({
            jobId: 'job-2',
            djvuPath: '/input.djvu',
            outputPath: join(tempDir, 'colored.pdf'),
            tempDir,
            pageCount: 3,
            sourceDpi: 300,
            pageSizes: pageSizes(3),
            pages: [3],
        });

        const manifest = await readFile(join(tempDir, 'compact-manifest.tsv'), 'utf8');
        expect(manifest).toMatch(/^image-jpeg\t288\.0000\t384\.0000\t75\t/u);
        expect(result.pageSpecs?.[0]?.reason).toBe('colored foreground probe');
        expect(renderModesForPage(3)).toEqual([
            'foreground',
            'full',
        ]);
    });

    it('uses layered JPEG output when a sparse mask has a detailed background', async () => {
        mocks.renderDjvuPageToImage.mockImplementation(async (
            _inputPath: string,
            outputPath: string,
            _pageNumber: number,
            _jobId: string,
            options: {
                mode?: string;
                format?: string
            } = {},
        ) => {
            await mkdir(dirname(outputPath), {recursive: true});
            if (options.mode === 'foreground') {
                await writeFile(outputPath, monochromeForegroundProbe());
            } else if (options.mode === 'mask') {
                await writeFile(outputPath, pbm(20, 20));
            } else if (options.mode === 'background') {
                await writeFile(outputPath, detailedBackgroundProbe());
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
        expect(manifest).toMatch(/^layered-jpeg\t288\.0000\t384\.0000\t75\t/u);
        expect(manifest).toContain('-background.ppm\t');
        expect(manifest).toContain('-mask.pbm');
        expect(renderModesForPage(44)).toEqual([
            'foreground',
            'mask',
            'background',
        ]);
    });

    it('falls back before background rendering when the foreground mask is blank', async () => {
        mocks.renderDjvuPageToImage.mockImplementation(async (
            _inputPath: string,
            outputPath: string,
            _pageNumber: number,
            _jobId: string,
            options: {
                mode?: string;
                format?: string
            } = {},
        ) => {
            await mkdir(dirname(outputPath), {recursive: true});
            if (options.mode === 'foreground') {
                await writeFile(outputPath, monochromeForegroundProbe());
            } else if (options.mode === 'mask') {
                await writeFile(outputPath, pbm(20, 20, () => false));
            } else if (options.mode === 'background') {
                throw new Error('Background should not be rendered for a blank mask');
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

        const result = await buildCompactDjvuAwarePdfFromDjvu({
            jobId: 'job-blank-mask',
            djvuPath: '/input.djvu',
            outputPath: join(tempDir, 'blank-mask.pdf'),
            tempDir,
            pageCount: 44,
            sourceDpi: 300,
            pageSizes: pageSizes(44),
            pages: [44],
        });

        const manifest = await readFile(join(tempDir, 'compact-manifest.tsv'), 'utf8');
        expect(manifest).toMatch(/^image-jpeg\t288\.0000\t384\.0000\t75\t/u);
        expect(result.pageSpecs?.[0]?.reason).toBe('blank foreground mask');
        expect(renderModesForPage(44)).toEqual([
            'foreground',
            'mask',
            'full',
        ]);
    });

    it('falls back before background rendering when the foreground mask is dense', async () => {
        mocks.renderDjvuPageToImage.mockImplementation(async (
            _inputPath: string,
            outputPath: string,
            _pageNumber: number,
            _jobId: string,
            options: {
                mode?: string;
                format?: string
            } = {},
        ) => {
            await mkdir(dirname(outputPath), {recursive: true});
            if (options.mode === 'foreground') {
                await writeFile(outputPath, monochromeForegroundProbe());
            } else if (options.mode === 'mask') {
                await writeFile(outputPath, pbm(20, 20, x => x < 10));
            } else if (options.mode === 'background') {
                throw new Error('Background should not be rendered for a dense mask');
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

        expect(result.pageSpecs?.[0]?.reason).toBe('dense foreground mask');
        expect(renderModesForPage(44)).toEqual([
            'foreground',
            'mask',
            'full',
        ]);
    });

    it('does not retry with a fallback render after a canceled layered render', async () => {
        const abortController = new AbortController();
        mocks.renderDjvuPageToImage.mockImplementation(async (
            _inputPath: string,
            outputPath: string,
            _pageNumber: number,
            _jobId: string,
            options: {
                mode?: string;
                format?: string
            } = {},
        ) => {
            await mkdir(dirname(outputPath), {recursive: true});
            if (options.mode === 'foreground') {
                await writeFile(outputPath, monochromeForegroundProbe());
                return {
                    success: true,
                    outputPath,
                    fileSize: 12,
                };
            }
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
            jobId: 'job-3',
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
            'foreground',
            'mask',
            'background',
        ]);
        expect(mocks.runRegisteredDjvuProcess).not.toHaveBeenCalled();
    });

    it('does not read oversized foreground probes during compact classification', async () => {
        vi.stubEnv('EVB_DJVU_COMPACT_NETPBM_MAX_MB', '1');
        vi.resetModules();
        const { buildCompactDjvuAwarePdfFromDjvu: buildCompactWithSmallNetpbmCap } = await import(
            '@electron/features/djvu/main/buildCompactDjvuAwarePdfFromDjvu'
        );
        mocks.renderDjvuPageToImage.mockImplementation(async (
            _inputPath: string,
            outputPath: string,
            _pageNumber: number,
            _jobId: string,
            options: {
                mode?: string;
                format?: string
            } = {},
        ) => {
            await mkdir(dirname(outputPath), {recursive: true});
            if (options.mode === 'foreground') {
                await writeFile(outputPath, Buffer.alloc(1024 * 1024 + 1));
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

        const result = await buildCompactWithSmallNetpbmCap({
            jobId: 'job-4',
            djvuPath: '/input.djvu',
            outputPath: join(tempDir, 'oversized-probe.pdf'),
            tempDir,
            pageCount: 44,
            sourceDpi: 300,
            pageSizes: pageSizes(44),
            pages: [44],
        });

        expect(result.success).toBe(true);
        if (!result.success) {
            throw new Error('Expected compact export to succeed through fallback');
        }
        const pageSpecs = result.pageSpecs ?? [];
        expect(pageSpecs[0]?.reason).toContain('Netpbm input exceeds safe read limit (1MB)');
        expect(renderModesForPage(44)).toEqual([
            'foreground',
            'full',
        ]);
    });
});

function renderModesForPage(pageNumber: number) {
    return mocks.renderDjvuPageToImage.mock.calls
        .filter(call => call[2] === pageNumber)
        .map(call => (call[4] as { mode?: string }).mode ?? 'full');
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
        index % 89 === 0 ? [
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
