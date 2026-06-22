import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import {
    copyFile,
    mkdir,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
    getPdfPageCount: vi.fn(),
    runQpdfCommand: vi.fn(),
    assertNonEmptyPdfOutput: vi.fn(),
    runNativeToolCommand: vi.fn(),
    tryWritePdfWithNativeImageCombiner: vi.fn(),
    validatePdfFile: vi.fn(),
    optimizePdfForSave: vi.fn(),
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    copyFileCopyOnWrite: vi.fn(),
}));

vi.mock('@electron/native-tools/getNativeToolPaths', () => ({getNativeToolPaths: () => ({
    pdftoppm: '/native/pdftoppm',
    qpdf: '/native/qpdf',
})}));
vi.mock('@electron/native-tools/buildPopplerEnv', () => ({buildPopplerEnv: () => undefined}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/features/page-ops/public', () => ({
    assertNonEmptyPdfOutput: (...args: unknown[]) => mocks.assertNonEmptyPdfOutput(...args),
    getPdfPageCount: (...args: unknown[]) => mocks.getPdfPageCount(...args),
    QPDF_OUTPUT_SUCCESS_EXIT_CODES: [0],
    QPDF_TIMEOUT_MS: 30_000,
    runQpdfCommand: (...args: unknown[]) => mocks.runQpdfCommand(...args),
}));
vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({tryWritePdfWithNativeImageCombiner: (...args: unknown[]) =>
    mocks.tryWritePdfWithNativeImageCombiner(...args)}));
vi.mock('@electron/features/documents/main/pdfConformance', () => ({validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args)}));
vi.mock('@electron/features/documents/main/pdfSaveAsOptimization', () => ({optimizePdfForSave: (...args: unknown[]) => mocks.optimizePdfForSave(...args)}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: [string, string]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: [string, string]) => mocks.copyFileCopyOnWrite(...args)}));

describe('pdfOptimization', () => {
    let tempRoot = '';

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        process.env.EVB_PDF_OPTIMIZE_RENDER_CHUNK_PAGES = '2';
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-pdf-optimization-test-'));
        mocks.getPdfPageCount.mockResolvedValue(3);
        mocks.assertNonEmptyPdfOutput.mockResolvedValue(undefined);
        mocks.validatePdfFile.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.optimizePdfForSave.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await copyFile(sourcePath, targetPath);
            await unlink(sourcePath);
        });
        mocks.copyFileCopyOnWrite.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await copyFile(sourcePath, targetPath);
        });
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            const firstPage = Number(args[args.indexOf('-f') + 1]);
            const lastPage = Number(args[args.indexOf('-l') + 1]);
            const outputPrefix = args.at(-1);
            if (typeof outputPrefix !== 'string') {
                throw new Error('Missing pdftoppm output prefix');
            }
            await mkdir(dirname(outputPrefix), {recursive: true});
            for (let page = firstPage; page <= lastPage; page += 1) {
                await writeFile(`${outputPrefix}-${page}.jpg`, `page-${page}`);
            }
            return {
                code: 0,
                signal: null,
                stdout: '',
                stderr: '',
            };
        });
        mocks.tryWritePdfWithNativeImageCombiner.mockImplementation(async (
            imagePaths: string[],
            outputPath: string,
            options?: {onProgress?: (progress: {
                processed: number;
                total: number;
            }) => void},
        ) => {
            options?.onProgress?.({
                processed: imagePaths.length,
                total: imagePaths.length,
            });
            await writeFile(outputPath, imagePaths.join('\n'));
            return true;
        });
        mocks.runQpdfCommand.mockImplementation(async (args: string[]) => {
            await writeFile(args.at(-1) as string, 'merged-pdf');
        });
    });

    afterEach(() => {
        delete process.env.EVB_PDF_OPTIMIZE_RENDER_CHUNK_PAGES;
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('rewrites a lossless optimized copy without rendering pages', async () => {
        const inputPath = join(tempRoot, 'input.pdf');
        const outputPath = join(tempRoot, 'output.pdf');
        writeFileSync(inputPath, 'input-pdf');
        const progress: unknown[] = [];
        const { optimizePdfToFile } = await import('@electron/features/documents/main/pdfOptimization');

        await expect(optimizePdfToFile(inputPath, outputPath, {preset: 'lossless'}, {
            requestId: 'opt-1',
            onProgress: payload => progress.push(payload),
        })).resolves.toMatchObject({
            path: outputPath,
            preset: 'lossless',
            originalBytes: 9,
            optimizedBytes: 9,
            pageCount: null,
        });

        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledWith(inputPath, `${outputPath}.tmp`);
        expect(mocks.optimizePdfForSave).toHaveBeenCalledWith(`${outputPath}.tmp`, expect.objectContaining({
            force: true,
            label: 'qpdf(pdf-optimize-final)',
            skipSemanticPreflight: true,
        }));
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(readFileSync(outputPath, 'utf8')).toBe('input-pdf');
        expect(progress).toEqual(expect.arrayContaining([
            expect.objectContaining({
                requestId: 'opt-1',
                phase: 'preparing',
                percent: 0,
            }),
            expect.objectContaining({
                requestId: 'opt-1',
                phase: 'complete',
                percent: 100,
            }),
        ]));
    });

    it('renders scanned optimization in page chunks and merges file-backed PDFs', async () => {
        const inputPath = join(tempRoot, 'scan.pdf');
        const outputPath = join(tempRoot, 'scan-optimized.pdf');
        writeFileSync(inputPath, 'scan-input');
        const progress: unknown[] = [];
        const { optimizePdfToFile } = await import('@electron/features/documents/main/pdfOptimization');

        await expect(optimizePdfToFile(inputPath, outputPath, {preset: 'smallScanned'}, {
            requestId: 'opt-2',
            onProgress: payload => progress.push(payload),
        })).resolves.toMatchObject({
            path: outputPath,
            preset: 'smallScanned',
            originalBytes: 10,
            optimizedBytes: 10,
            pageCount: 3,
        });

        expect(mocks.runNativeToolCommand).toHaveBeenCalledTimes(2);
        expect(mocks.runNativeToolCommand).toHaveBeenNthCalledWith(
            1,
            '/native/pdftoppm',
            expect.arrayContaining([
                '-gray',
                '-jpeg',
                '-jpegopt',
                'quality=60',
                '-r',
                '150',
                '-f',
                '1',
                '-l',
                '2',
                inputPath,
            ]),
            expect.objectContaining({commandLabel: 'pdftoppm(pdf-optimize)'}),
        );
        expect(mocks.runNativeToolCommand).toHaveBeenNthCalledWith(
            2,
            '/native/pdftoppm',
            expect.arrayContaining([
                '-f',
                '3',
                '-l',
                '3',
                inputPath,
            ]),
            expect.objectContaining({commandLabel: 'pdftoppm(pdf-optimize)'}),
        );
        expect(mocks.tryWritePdfWithNativeImageCombiner).toHaveBeenCalledTimes(2);
        expect(mocks.tryWritePdfWithNativeImageCombiner.mock.calls[0]?.[0]).toHaveLength(2);
        expect(mocks.tryWritePdfWithNativeImageCombiner.mock.calls[1]?.[0]).toHaveLength(1);
        expect(mocks.runQpdfCommand).toHaveBeenCalledWith(
            [
                '--empty',
                '--pages',
                expect.stringMatching(/chunk-00001\.pdf$/u),
                '1-z',
                expect.stringMatching(/chunk-00002\.pdf$/u),
                '1-z',
                '--',
                `${outputPath}.tmp`,
            ],
            expect.objectContaining({commandLabel: 'qpdf(pdf-optimize-merge)'}),
        );
        expect(mocks.optimizePdfForSave).toHaveBeenCalledWith(`${outputPath}.tmp`, expect.objectContaining({label: 'qpdf(pdf-optimize-final)'}));
        expect(readFileSync(outputPath, 'utf8')).toBe('merged-pdf');
        expect(progress).toEqual(expect.arrayContaining([
            expect.objectContaining({
                requestId: 'opt-2',
                preset: 'smallScanned',
                phase: 'rendering',
                processed: 2,
                total: 3,
            }),
            expect.objectContaining({
                requestId: 'opt-2',
                phase: 'assembling',
                processed: 3,
                total: 3,
            }),
            expect.objectContaining({
                requestId: 'opt-2',
                phase: 'complete',
                percent: 100,
            }),
        ]));
    });

    it('rejects unknown optimize presets', async () => {
        const { optimizePdfToFile } = await import('@electron/features/documents/main/pdfOptimization');

        await expect(optimizePdfToFile(
            '/tmp/input.pdf',
            '/tmp/output.pdf',
            {preset: 'giant'} as never,
            {requestId: 'opt-3'},
        )).rejects.toThrow('Invalid PDF optimize options');
    });
});
