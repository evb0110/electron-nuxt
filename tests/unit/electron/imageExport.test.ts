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
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IUtifFrame {
    width?: number;
    height?: number;
    t273?: number[];
    [key: string]: unknown;
}

interface IUtifModule {
    decode(input: Uint8Array | ArrayBuffer): IUtifFrame[];
    decodeImage(input: Uint8Array | ArrayBuffer, frame: IUtifFrame): void;
    toRGBA8(frame: IUtifFrame): Uint8Array;
    encodeImage(
        rgba: Uint8Array | ArrayBuffer,
        width: number,
        height: number,
    ): ArrayBuffer;
}

const mocks = vi.hoisted(() => ({
    runCommand: vi.fn(),
    stat: vi.fn(),
    rename: vi.fn(),
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    renderPageCount: 2,
    pdfPageCount: 2,
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

vi.mock('@electron/native-tools/paths', () => ({getNativeToolPaths: () => ({
    pdftoppm: '/mock/pdftoppm',
    qpdf: '/mock/qpdf',
})}));

vi.mock('@electron/native-tools/exec', () => ({runNativeToolCommand: mocks.runCommand}));
vi.mock('pdf-lib', () => ({PDFDocument: {load: vi.fn(async () => ({ getPageCount: () => mocks.pdfPageCount }))}}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
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
} = await import('@electron/features/image-export/main/export');
const { combinePagesIntoMultiPageTiffLocal } = await import('@electron/features/image-export/main/tiffCombineLocal');

const UTIF = utifModule as IUtifModule;

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
        mocks.stat.mockImplementation(async () => ({
            isFile: () => true,
            size: 1024,
        }));
        mocks.rename.mockResolvedValue(undefined);
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

            if (command !== '/mock/pdftoppm') {
                throw new Error(`Unexpected command: ${command}`);
            }

            const prefix = args[args.length - 1];
            if (typeof prefix !== 'string') {
                throw new Error('Expected pdftoppm output prefix');
            }

            const formatArg = args[0];
            const extension = formatArg === '-png'
                ? 'png'
                : formatArg === '-jpeg'
                    ? 'jpg'
                    : 'tif';

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

        const resultPath = await exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath);
        expect(resultPath).toBe(outputPath);

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
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, outputPath);
        expect(await readFile(outputPath, 'utf8')).toBe('page-1-png');
        expect(existsSync(tempPath)).toBe(false);
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
});
