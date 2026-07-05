import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import type * as FsPromises from 'fs/promises';
import * as utifModule from 'utif';
import { decode as decodePng } from 'fast-png';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    runCommand: vi.fn(),
    stat: vi.fn(),
    rename: vi.fn(),
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    renderPageCount: 2,
    pdfPageCount: 2,
    nativeImageCombinePath: null as string | null,
    pdfimagesPath: undefined as string | undefined,
    popplerDataDir: undefined as string | undefined,
    popplerFontConfigDir: undefined as string | undefined,
}));

vi.mock('fs/promises', async () => {
    const actual = await vi.importActual<typeof FsPromises>('fs/promises');
    return {
        ...actual,
        readFile: async (path: Parameters<typeof actual.readFile>[0], ...args: Parameters<typeof actual.readFile> extends [unknown, ...infer Rest] ? Rest : never) => {
            if (String(path) === '/tmp/input.pdf') {
                return Buffer.from('%PDF-1.7\n%%EOF\n');
            }
            return actual.readFile(path, ...args);
        },
        rename: mocks.rename,
        stat: mocks.stat,
    };
});

vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => ({
    pdftoppm: '/mock/pdftoppm',
    qpdf: '/mock/qpdf',
    pdfimages: mocks.pdfimagesPath,
    popplerDataDir: mocks.popplerDataDir,
    popplerFontConfigDir: mocks.popplerFontConfigDir,
})}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runCommand}));
vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({
    isNativePdfImageCombineDisabled: () => mocks.nativeImageCombinePath === null,
    resolveNativePdfImageCombinePath: () => mocks.nativeImageCombinePath,
}));
vi.mock('pdf-lib', () => ({PDFDocument: {load: vi.fn(async () => ({ getPageCount: () => mocks.pdfPageCount }))}}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));

const {
    exportPdfAsMultiPageTiff,
    exportPdfPagesAsImages,
    normalizeImageExportPath,
} = await import('@electron/features/image-export/main/export');
const {
    combinePagesIntoMultiPageTiffLocal,
    estimateMultiPageTiffByteLength,
    splitTiffPageDescriptorsForClassicLimit,
} = await import('@electron/features/image-export/main/combinePagesIntoMultiPageTiffLocal');

const UTIF = utifModule;

function expectSinglePixelPng(bytes: Uint8Array, rgb: [number, number, number]) {
    const decoded = decodePng(bytes);
    expect(decoded.width).toBe(1);
    expect(decoded.height).toBe(1);
    expect(decoded.channels).toBe(3);
    expect(Array.from(decoded.data.slice(0, 3))).toEqual(rgb);
}

function countTiffDirectories(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = view.getUint32(4, false);
    let count = 0;

    while (offset !== 0) {
        expect(offset + 2).toBeLessThanOrEqual(bytes.byteLength);
        const entryCount = view.getUint16(offset, false);
        const nextPointerOffset = offset + 2 + (entryCount * 12);
        expect(nextPointerOffset + 4).toBeLessThanOrEqual(bytes.byteLength);
        offset = view.getUint32(nextPointerOffset, false);
        count += 1;
        expect(count).toBeLessThan(256);
    }

    return count;
}

describe('image export', () => {
    let tempDir = '';

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'image-export-test-'));
        mocks.runCommand.mockReset();
        mocks.stat.mockReset();
        mocks.rename.mockReset();
        mocks.atomicReplace.mockReset();
        mocks.makeSiblingTempPath.mockClear();
        mocks.renderPageCount = 2;
        mocks.pdfPageCount = 2;
        mocks.nativeImageCombinePath = null;
        mocks.pdfimagesPath = undefined;
        mocks.popplerDataDir = undefined;
        mocks.popplerFontConfigDir = undefined;
        mocks.stat.mockImplementation(async () => ({
            isFile: () => true,
            size: 1024,
        }));
        mocks.rename.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
            await rm(sourcePath, { force: true });
        });
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
            await rm(sourcePath, { force: true });
        });
        mocks.runCommand.mockImplementation(async (command: string, args: string[]) => {
            if (command === '/mock/qpdf' && args[0] === '--show-npages') {
                return {
                    stdout: String(mocks.pdfPageCount),
                    stderr: '',
                    exitCode: 0,
                };
            }

            if (command === mocks.pdfimagesPath) {
                const firstPageArgIndex = args.indexOf('-f');
                const lastPageArgIndex = args.indexOf('-l');
                const firstPage = firstPageArgIndex >= 0
                    ? Number.parseInt(String(args[firstPageArgIndex + 1]), 10)
                    : 1;
                const lastPage = lastPageArgIndex >= 0
                    ? Number.parseInt(String(args[lastPageArgIndex + 1]), 10)
                    : mocks.pdfPageCount;

                return {
                    stdout: [
                        'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
                        ...Array.from({ length: lastPage - firstPage + 1 }, (_, index) => {
                            const page = firstPage + index;
                            return `${String(page).padStart(4, ' ')}     0 image     100   100  rgb     3   8  image  no         1  0   360   360 1.0K 1.0%`;
                        }),
                    ].join('\n'),
                    stderr: '',
                    exitCode: 0,
                };
            }

            if (command === mocks.nativeImageCombinePath) {
                expect(args).toContain('png');
                const outputArgIndex = args.indexOf('--output');
                const outputPath = args[outputArgIndex + 1];
                if (typeof outputPath !== 'string') {
                    throw new Error('Expected native image combiner output path');
                }
                await writeFile(outputPath, 'native-png');
                return {
                    stdout: '',
                    stderr: '',
                    exitCode: 0,
                };
            }

            if (command !== '/mock/pdftoppm') {
                throw new Error(`Unexpected command: ${command}`);
            }

            const prefix = args[args.length - 1];
            if (typeof prefix !== 'string') {
                throw new Error('Expected pdftoppm output prefix');
            }

            const formatArg = args.includes('-png')
                ? '-png'
                : args.includes('-jpeg')
                    ? '-jpeg'
                    : args.includes('-tiff')
                        ? '-tiff'
                        : '-ppm';
            const extension = formatArg === '-png'
                ? 'png'
                : formatArg === '-jpeg'
                    ? 'jpg'
                    : formatArg === '-tiff'
                        ? 'tif'
                        : 'ppm';

            const firstPageArgIndex = args.indexOf('-f');
            const lastPageArgIndex = args.indexOf('-l');
            const firstPage = firstPageArgIndex >= 0
                ? Number.parseInt(String(args[firstPageArgIndex + 1]), 10)
                : 1;
            const lastPage = lastPageArgIndex >= 0
                ? Number.parseInt(String(args[lastPageArgIndex + 1]), 10)
                : mocks.renderPageCount;

            for (let page = firstPage; page <= lastPage; page += 1) {
                const pageBytes = extension === 'tif'
                    ? Buffer.from(UTIF.encodeImage(new Uint8Array([
                        page === 1 ? 255 : 0,
                        page === 2 ? 255 : 0,
                        0,
                        255,
                    ]), 1, 1))
                    : extension === 'ppm'
                        ? Buffer.concat([
                            Buffer.from('P6\n1 1\n255\n'),
                            Buffer.from([
                                page,
                                0,
                                0,
                            ]),
                        ])
                        : Buffer.from(`page-${page}-${extension}`);
                await writeFile(`${prefix}-${page}.${extension}`, pageBytes);
            }

            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
            };
        });
    });

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('creates a multi-page TIFF without host tool fallbacks', async () => {
        const outputPath = join(tempDir, 'exported.tiff');

        const resultPaths = await exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath);
        expect(resultPaths).toEqual([outputPath]);

        const outputBytes = new Uint8Array(await readFile(outputPath));
        const ifds = UTIF.decode(outputBytes);
        expect(ifds.length).toBeGreaterThanOrEqual(2);

        UTIF.decodeImage(outputBytes, ifds[0]!);
        UTIF.decodeImage(outputBytes, ifds[1]!);

        const firstRgba = UTIF.toRGBA8(ifds[0]!);
        const secondRgba = UTIF.toRGBA8(ifds[1]!);

        expect(Array.from(firstRgba.slice(0, 4))).toEqual([
            255,
            0,
            0,
            255,
        ]);
        expect(Array.from(secondRgba.slice(0, 4))).toEqual([
            0,
            255,
            0,
            255,
        ]);

        expect(mocks.runCommand).toHaveBeenCalledWith(
            '/mock/pdftoppm',
            expect.any(Array),
            expect.objectContaining({
                timeoutMs: 180_000,
                commandLabel: 'pdftoppm(export-tiff)',
            }),
        );
    });

    it('reports multi-page TIFF render and combine progress', async () => {
        const outputPath = join(tempDir, 'progress.tiff');
        const progress = vi.fn();

        await expect(exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath, {onProgress: progress}))
            .resolves
            .toEqual([outputPath]);

        expect(progress).toHaveBeenCalledWith({
            phase: 'rendering',
            processed: 0,
            total: 2,
            percent: 0,
        });
        expect(progress).toHaveBeenCalledWith({
            phase: 'rendering',
            processed: 2,
            total: 2,
            percent: 90,
        });
        expect(progress).toHaveBeenCalledWith({
            phase: 'combining',
            processed: 1,
            total: 1,
            percent: 100,
        });
    });

    it('bounds export DPI probes to the current render chunk', async () => {
        mocks.pdfimagesPath = '/mock/pdfimages';
        mocks.renderPageCount = 6;
        mocks.pdfPageCount = 6;

        const outputPath = join(tempDir, 'bounded.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toHaveLength(6);

        const pdfimagesCalls = mocks.runCommand.mock.calls.filter(([command]) => command === '/mock/pdfimages');
        expect(pdfimagesCalls.map((call) => {
            const args = call[1];
            return [
                args[args.indexOf('-f') + 1],
                args[args.indexOf('-l') + 1],
            ];
        })).toEqual([
            [
                '1',
                '5',
            ],
            [
                '6',
                '6',
            ],
        ]);

        const pdftoppmCalls = mocks.runCommand.mock.calls.filter(([command]) => command === '/mock/pdftoppm');
        expect(pdftoppmCalls.map((call) => {
            const args = call[1];
            return args[args.indexOf('-r') + 1];
        })).toEqual([
            '360',
            '360',
        ]);
    });

    it('uses the default export DPI when the bounded DPI probe fails', async () => {
        mocks.pdfimagesPath = '/mock/pdfimages';
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        const defaultRunCommand = mocks.runCommand.getMockImplementation();
        if (!defaultRunCommand) {
            throw new Error('Expected default command mock');
        }

        mocks.runCommand.mockImplementation(async (command: string, args: string[]) => {
            if (command === '/mock/pdfimages') {
                throw new Error('probe timed out');
            }
            return defaultRunCommand(command, args);
        });

        const outputPath = join(tempDir, 'fallback.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        const pdftoppmCall = mocks.runCommand.mock.calls.find(([command]) => command === '/mock/pdftoppm');
        const pdftoppmArgs = pdftoppmCall?.[1];
        expect(pdftoppmArgs?.[pdftoppmArgs.indexOf('-r') + 1]).toBe('300');
    });

    it('passes bundled Poppler runtime environment to export Poppler commands', async () => {
        mocks.pdfimagesPath = '/mock/pdfimages';
        mocks.popplerDataDir = '/mock/poppler/share/poppler';
        mocks.popplerFontConfigDir = '/mock/poppler/etc/fonts';
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;

        const outputPath = join(tempDir, 'poppler-env.png');
        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        const expectedEnv = {
            POPPLER_DATADIR: '/mock/poppler/share/poppler',
            FONTCONFIG_PATH: '/mock/poppler/etc/fonts',
            FONTCONFIG_FILE: '/mock/poppler/etc/fonts/fonts.conf',
        };
        const pdfimagesCall = mocks.runCommand.mock.calls.find(([command]) => command === '/mock/pdfimages');
        expect(pdfimagesCall?.[2]).toMatchObject({env: expectedEnv});
        const pdftoppmCall = mocks.runCommand.mock.calls.find(([command]) => command === '/mock/pdftoppm');
        expect(pdftoppmCall?.[2]).toMatchObject({env: expectedEnv});
    });

    it('keeps the full TIFF directory chain intact well past the legacy UTIF header limit', async () => {
        const outputPath = join(tempDir, 'large-local-combine.tiff');
        const pagePaths: string[] = [];
        const pageCount = 120;

        for (let index = 0; index < pageCount; index += 1) {
            const pagePath = join(tempDir, `page-${String(index + 1).padStart(3, '0')}.tif`);
            const pageBytes = Buffer.from(UTIF.encodeImage(new Uint8Array([
                index,
                0,
                0,
                255,
            ]), 1, 1));
            await writeFile(pagePath, pageBytes);
            pagePaths.push(pagePath);
        }

        await combinePagesIntoMultiPageTiffLocal(pagePaths, outputPath);

        const outputBytes = new Uint8Array(await readFile(outputPath));
        expect(countTiffDirectories(outputBytes)).toBe(pageCount);

        const ifds = UTIF.decode(outputBytes);
        expect(ifds).toHaveLength(pageCount);
        expect(ifds[0]?.t273?.[0] ?? 0).toBeGreaterThan(20_000);

        UTIF.decodeImage(outputBytes, ifds[pageCount - 1]!);
        const lastRgba = UTIF.toRGBA8(ifds[pageCount - 1]!);
        expect(Array.from(lastRgba.slice(0, 4))).toEqual([
            pageCount - 1,
            0,
            0,
            255,
        ]);
    });

    it('splits TIFF descriptors into classic-size multi-page parts', () => {
        const descriptors = [
            {
                path: '/tmp/page-1.tif',
                width: 1,
                height: 1,
                dataLength: 400,
            },
            {
                path: '/tmp/page-2.tif',
                width: 1,
                height: 1,
                dataLength: 400,
            },
            {
                path: '/tmp/page-3.tif',
                width: 1,
                height: 1,
                dataLength: 400,
            },
        ];
        const twoPageLimit = estimateMultiPageTiffByteLength(descriptors.slice(0, 2));

        expect(splitTiffPageDescriptorsForClassicLimit(descriptors, twoPageLimit)).toEqual([
            [
                descriptors[0],
                descriptors[1],
            ],
            [descriptors[2]],
        ]);
    });

    it('rejects a TIFF split when a single page exceeds the classic-size limit', () => {
        const descriptor = {
            path: '/tmp/page-1.tif',
            width: 1,
            height: 1,
            dataLength: 400,
        };

        expect(() => splitTiffPageDescriptorsForClassicLimit(
            [descriptor],
            estimateMultiPageTiffByteLength([descriptor]) - 1,
        )).toThrow('A single TIFF page exceeds the Classic TIFF 4GB limit');
    });

    it('rejects large TIFF exports when worker startup fails and local fallback is unsafe', async () => {
        mocks.stat.mockImplementation(async (path: string) => ({
            isFile: () => true,
            size: path.includes('-1.tif') || path.includes('-2.tif')
                ? 32 * 1024 * 1024
                : 1024,
        }));

        const outputPath = join(tempDir, 'large-export.tiff');

        await expect(exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath))
            .rejects
            .toThrow('TIFF combine worker unavailable and local fallback is disabled for exports larger than 2 pages or 16MB');
    });

    it('uses sibling temp and atomic replace for image export EXDEV fallback', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        mocks.rename.mockRejectedValue(Object.assign(new Error('Cross-device link'), {code: 'EXDEV'}));

        const outputPath = join(tempDir, 'exported.png');
        const tempPath = `${outputPath}.tmp`;

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        expect(mocks.makeSiblingTempPath).toHaveBeenCalledWith(outputPath);
        expect(mocks.atomicReplace).toHaveBeenCalledWith(`${tempPath}.tmp`, tempPath);
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, outputPath);
        expectSinglePixelPng(new Uint8Array(await readFile(outputPath)), [
            1,
            0,
            0,
        ]);
        expect(existsSync(tempPath)).toBe(false);
    });

    it('normalizes extensionless image targets with a JPEG fallback when requested', () => {
        expect(normalizeImageExportPath(join(tempDir, 'exported'), 'jpeg')).toEqual({
            normalizedPath: join(tempDir, 'exported.jpg'),
            format: 'jpeg',
        });
    });

    it('exports JPEG page images when the target extension is JPG', async () => {
        const outputPath = join(tempDir, 'exported.jpg');
        const firstOutputPath = join(tempDir, 'exported-001.jpg');
        const secondOutputPath = join(tempDir, 'exported-002.jpg');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([
            firstOutputPath,
            secondOutputPath,
        ]);

        const pdftoppmCall = mocks.runCommand.mock.calls.find(([command]) => command === '/mock/pdftoppm');
        expect(pdftoppmCall?.[1]).toContain('-jpeg');
        expect(pdftoppmCall?.[1]).not.toContain('-png');
        expect(pdftoppmCall?.[1]).not.toContain('-tiff');
        expect(await readFile(firstOutputPath, 'utf8')).toBe('page-1-jpg');
        expect(await readFile(secondOutputPath, 'utf8')).toBe('page-2-jpg');
    });

    it('exports TIFF page images when the target extension is TIF', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;

        const outputPath = join(tempDir, 'exported.tif');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        const pdftoppmCall = mocks.runCommand.mock.calls.find(([command]) => command === '/mock/pdftoppm');
        expect(pdftoppmCall?.[1]).toContain('-tiff');
        expect(pdftoppmCall?.[1]).not.toContain('-png');
        expect(pdftoppmCall?.[1]).not.toContain('-jpeg');

        const outputBytes = new Uint8Array(await readFile(outputPath));
        const ifds = UTIF.decode(outputBytes);
        expect(ifds).toHaveLength(1);
        UTIF.decodeImage(outputBytes, ifds[0]!);
        expect(Array.from(UTIF.toRGBA8(ifds[0]!).slice(0, 4))).toEqual([
            255,
            0,
            0,
            255,
        ]);
    });

    it('renders PNG exports through raw PPM before encoding to avoid slow native PNG output', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;

        const outputPath = join(tempDir, 'exported.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        const pdftoppmCall = mocks.runCommand.mock.calls.find(([command]) => command === '/mock/pdftoppm');
        expect(pdftoppmCall?.[1]).not.toContain('-png');
        expectSinglePixelPng(new Uint8Array(await readFile(outputPath)), [
            1,
            0,
            0,
        ]);
    });

    it('uses native PPM-to-PNG encoding when the Rust image combiner is available', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        mocks.nativeImageCombinePath = '/native/evb-pdf-image-combine';

        const outputPath = join(tempDir, 'exported.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        expect(mocks.runCommand).toHaveBeenCalledWith('/native/evb-pdf-image-combine', [
            '--format',
            'png',
            '--output',
            expect.stringMatching(/page-1\.png$/u),
            '--',
            expect.stringMatching(/page-1\.ppm$/u),
        ], expect.objectContaining({commandLabel: 'evb-pdf-image-combine(ppm-to-png)'}));
        expect(await readFile(outputPath, 'utf8')).toBe('native-png');
    });

    it('rejects oversized rendered PPM fallback output before reading it into memory', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        mocks.stat.mockImplementation(async (path: string) => ({
            isFile: () => true,
            size: path.endsWith('.ppm') ? 193 * 1024 * 1024 : 1024,
        }));

        const outputPath = join(tempDir, 'oversized.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath))
            .rejects
            .toThrow('Rendered PPM output exceeds safe read limit (192MB)');
    });

    it('keeps an existing image target when EXDEV atomic replacement fails', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        mocks.rename.mockRejectedValue(Object.assign(new Error('Cross-device link'), {code: 'EXDEV'}));
        mocks.atomicReplace.mockRejectedValue(new Error('replace failed'));

        const outputPath = join(tempDir, 'existing.png');
        const tempPath = `${outputPath}.tmp`;
        await writeFile(outputPath, 'old-target');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath))
            .rejects
            .toThrow('replace failed');

        expect(await readFile(outputPath, 'utf8')).toBe('old-target');
        expect(existsSync(tempPath)).toBe(false);
    });

    it('restores promoted multi-page image targets when a later promotion fails', async () => {
        mocks.renderPageCount = 2;
        mocks.pdfPageCount = 2;

        const outputPath = join(tempDir, 'existing.png');
        const firstTargetPath = join(tempDir, 'existing-001.png');
        const secondTargetPath = join(tempDir, 'existing-002.png');

        await writeFile(firstTargetPath, 'old-page-1');
        await writeFile(secondTargetPath, 'old-page-2');

        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            if (targetPath === secondTargetPath) {
                throw new Error('second promotion failed');
            }

            await writeFile(targetPath, await readFile(sourcePath));
            await rm(sourcePath, { force: true });
        });

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath))
            .rejects
            .toThrow('second promotion failed');

        expect(await readFile(firstTargetPath, 'utf8')).toBe('old-page-1');
        expect(await readFile(secondTargetPath, 'utf8')).toBe('old-page-2');
    });

    it('removes staged image outputs when export is canceled before promotion', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        const controller = new AbortController();
        mocks.runCommand.mockImplementationOnce(async () => ({
            stdout: '1',
            stderr: '',
            exitCode: 0,
        })).mockImplementationOnce(async (command: string, args: string[]) => {
            const prefix = args[args.length - 1];
            if (command !== '/mock/pdftoppm' || typeof prefix !== 'string') {
                throw new Error('Unexpected command');
            }
            await writeFile(`${prefix}-1.ppm`, Buffer.concat([
                Buffer.from('P6\n1 1\n255\n'),
                Buffer.from([
                    1,
                    0,
                    0,
                ]),
            ]));
            controller.abort();
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
            };
        });

        const outputPath = join(tempDir, 'canceled.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath, { signal: controller.signal }))
            .rejects
            .toThrow('The operation was aborted');

        expect(existsSync(outputPath)).toBe(false);
        expect(existsSync(`${outputPath}.tmp`)).toBe(false);
    });
});
