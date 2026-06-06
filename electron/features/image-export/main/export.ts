import {existsSync} from 'fs';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readdir,
    stat,
    rename,
    rm,
    unlink,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import {
    basename,
    dirname as dirnameFromPath,
    dirname,
    extname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import {
    sortBy,
    uniq,
} from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import { isErrnoException } from '@contracts/runtimeGuards';
import { getNativeToolPaths } from '@electron/native-tools/getNativeToolPaths';
import {
    detectSourceDpi,
    clampDpi,
} from '@electron/ocr/worker/dpiDetection';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { createLogger } from '@electron/utils/createLogger';
import { measureElectronPerfAsync } from '@electron/utils/measureElectronPerfAsync';
import { combinePagesIntoMultiPageTiffLocal } from '@electron/features/image-export/main/combinePagesIntoMultiPageTiffLocal';
import {
    resolveUnpackedWorkerPath,
    runResultWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';

type TImageExportFormat = 'png' | 'jpeg' | 'tiff';

interface IRenderedPageFile {
    page: number;
    path: string;
}

interface IExportPdfOptions {
    pageNumbers?: number[];
    signal?: AbortSignal;
}

interface IPreparedSourcePdf {
    pdfPath: string;
    cleanup: () => Promise<void>;
}

const logger = createLogger('image-export');
const __dirname = dirnameFromPath(fileURLToPath(import.meta.url));
const PDFTOPPM_TIMEOUT_MS = 3 * 60 * 1000;
const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const PDF_EXPORT_MAX_PAGES = parseIntegerEnv('EVB_PDF_IMAGE_EXPORT_MAX_PAGES', 500, 1, 10_000);
const PDF_EXPORT_RENDER_CHUNK_PAGES = parseIntegerEnv('EVB_PDF_IMAGE_EXPORT_RENDER_CHUNK_PAGES', 25, 1, 100);
const TIFF_COMBINE_WORKER_TIMEOUT_MS = 10 * 60 * 1000;
const TIFF_COMBINE_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['image-export-tiff'].fileName;
const TIFF_COMBINE_LOCAL_FALLBACK_MAX_PAGES = (() => {
    const parsed = Number.parseInt(process.env.EVB_TIFF_COMBINE_FALLBACK_MAX_PAGES ?? '2', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 2;
    }
    return Math.min(parsed, 16);
})();
const TIFF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_TIFF_COMBINE_FALLBACK_MAX_TOTAL_MB ?? '16', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 16 * 1024 * 1024;
    }
    return Math.min(parsed, 128) * 1024 * 1024;
})();

function resolveFormatExtension(format: TImageExportFormat) {
    if (format === 'jpeg') {
        return '.jpg';
    }
    if (format === 'tiff') {
        return '.tif';
    }
    return '.png';
}

function parseImageExportFormat(filePath: string): TImageExportFormat {
    const extension = extname(filePath).toLowerCase();

    if (extension === '.jpg' || extension === '.jpeg') {
        return 'jpeg';
    }
    if (extension === '.tif' || extension === '.tiff') {
        return 'tiff';
    }

    return 'png';
}

export function normalizeImageExportPath(filePath: string, fallbackFormat: TImageExportFormat = 'png'): {
    normalizedPath: string;
    format: TImageExportFormat;
} {
    const trimmedPath = filePath.trim();
    const extension = extname(trimmedPath).toLowerCase();

    if (extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.tif' || extension === '.tiff') {
        const format = parseImageExportFormat(trimmedPath);
        return {
            normalizedPath: trimmedPath,
            format,
        };
    }

    const format = fallbackFormat;
    return {
        normalizedPath: `${trimmedPath}${resolveFormatExtension(format)}`,
        format,
    };
}

function toPdftoppmFormatArg(format: TImageExportFormat) {
    if (format === 'jpeg') {
        return '-jpeg';
    }
    if (format === 'tiff') {
        return '-tiff';
    }
    return '-png';
}

function parsePageNumber(fileName: string) {
    const match = fileName.match(/-(\d+)\.[^.]+$/);
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }
    return Number.parseInt(match[1] ?? '', 10);
}

function isExpectedPageFile(fileName: string, format: TImageExportFormat) {
    const extension = extname(fileName).toLowerCase();

    if (format === 'jpeg') {
        return extension === '.jpg' || extension === '.jpeg';
    }
    if (format === 'tiff') {
        return extension === '.tif' || extension === '.tiff';
    }

    return extension === '.png';
}

async function moveFile(sourcePath: string, targetPath: string) {
    try {
        await rename(sourcePath, targetPath);
    } catch (error) {
        if (!isErrnoException(error) || error.code !== 'EXDEV') {
            throw error;
        }

        const tempPath = makeSiblingTempPath(targetPath);
        let replaced = false;
        try {
            await copyFile(sourcePath, tempPath);
            await atomicReplace(tempPath, targetPath);
            replaced = true;
            await unlink(sourcePath);
        } finally {
            if (!replaced) {
                await rm(tempPath, { force: true }).catch(() => undefined);
            }
        }
    }
}

async function promoteStagedFiles(
    stagedFiles: Array<{
        stagedPath: string;
        targetPath: string;
        targetExisted: boolean;
    }>,
) {
    const promotedFiles: Array<{
        targetPath: string;
        backupPath: string | null;
    }> = [];
    const backupPaths: string[] = [];
    try {
        for (const stagedFile of stagedFiles) {
            const backupPath = stagedFile.targetExisted
                ? makeSiblingTempPath(stagedFile.targetPath)
                : null;
            if (backupPath) {
                await copyFile(stagedFile.targetPath, backupPath);
                backupPaths.push(backupPath);
            }
            await atomicReplace(stagedFile.stagedPath, stagedFile.targetPath);
            promotedFiles.push({
                targetPath: stagedFile.targetPath,
                backupPath,
            });
        }
    } catch (error) {
        await Promise.all(stagedFiles.map(stagedFile => rm(stagedFile.stagedPath, { force: true }).catch(() => undefined)));
        await Promise.all([...promotedFiles].reverse().map(async (promotedFile) => {
            if (promotedFile.backupPath) {
                await atomicReplace(promotedFile.backupPath, promotedFile.targetPath).catch(() => undefined);
                return;
            }

            await rm(promotedFile.targetPath, { force: true }).catch(() => undefined);
        }));
        await Promise.all(backupPaths.map(backupPath => rm(backupPath, { force: true }).catch(() => undefined)));
        throw error;
    }

    await Promise.all(backupPaths.map(backupPath => rm(backupPath, { force: true }).catch(() => undefined)));
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new Error('The operation was aborted');
    }
}

async function getPdfPageCount(pdfPath: string) {
    const result = await runNativeToolCommand(getNativeToolPaths().qpdf, [
        '--show-npages',
        pdfPath,
    ], {
        timeoutMs: QPDF_TIMEOUT_MS,
        commandLabel: 'qpdf(export-page-count)',
    });
    const pageCount = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isInteger(pageCount) || pageCount < 1) {
        throw new Error('Failed to read PDF page count');
    }
    return pageCount;
}

function assertExportPageCountWithinLimit(pageCount: number) {
    if (!Number.isInteger(pageCount) || pageCount < 1) {
        throw new Error('PDF export source has no pages');
    }
    if (pageCount > PDF_EXPORT_MAX_PAGES) {
        throw new Error(`PDF image export is capped at ${PDF_EXPORT_MAX_PAGES} pages`);
    }
}

async function renderPdfToTempPages(
    pdfPath: string,
    format: TImageExportFormat,
    pageRange: {
        firstPage: number;
        lastPage: number;
    },
    signal?: AbortSignal,
): Promise<IRenderedPageFile[]> {
    const tempDir = await mkdtemp(join(tmpdir(), 'pdfExport-'));
    const prefix = join(tempDir, 'page');
    const paths = getNativeToolPaths();
    throwIfAborted(signal);

    try {
        const detectedDpi = await detectSourceDpi(
            pdfPath,
            paths.pdfimages,
            (level, message) => logger[level === 'error' ? 'error' : 'debug'](message),
            undefined,
            signal,
        );
        const renderDpi = clampDpi(detectedDpi ?? 300);

        throwIfAborted(signal);
        await runNativeToolCommand(paths.pdftoppm, [
            toPdftoppmFormatArg(format),
            '-r',
            String(renderDpi),
            '-f',
            String(pageRange.firstPage),
            '-l',
            String(pageRange.lastPage),
            pdfPath,
            prefix,
        ], {
            timeoutMs: PDFTOPPM_TIMEOUT_MS,
            commandLabel: `pdftoppm(export-${format})`,
            ...(signal ? { signal } : {}),
        });
        throwIfAborted(signal);

        const fileNames = await readdir(tempDir);
        const pageFiles = sortBy(
            fileNames
                .filter(fileName => fileName.startsWith('page-'))
                .filter(fileName => isExpectedPageFile(fileName, format))
                .map(fileName => ({
                    fileName,
                    page: parsePageNumber(fileName),
                })),
            ['page'],
        )
            .map((file) => ({
                page: file.page,
                path: join(tempDir, file.fileName),
            }));

        if (pageFiles.length === 0) {
            throw new Error('No page images were generated from the PDF');
        }

        return pageFiles;
    } catch (error) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
        throw error;
    }
}

function normalizePageNumbers(pageNumbers: number[] | undefined): number[] | null {
    if (!pageNumbers) {
        return null;
    }

    const unique = uniq(pageNumbers)
        .filter(page => Number.isInteger(page) && page > 0)
        .sort((left, right) => left - right);

    if (unique.length === 0) {
        throw new Error('At least one page number must be provided for scoped export');
    }

    return unique;
}

function formatPageList(pageNumbers: number[]) {
    const ranges: string[] = [];
    let rangeStart: number | null = null;
    let previous: number | null = null;

    for (const pageNumber of pageNumbers) {
        if (rangeStart === null || previous === null) {
            rangeStart = pageNumber;
            previous = pageNumber;
            continue;
        }

        if (pageNumber === previous + 1) {
            previous = pageNumber;
            continue;
        }

        ranges.push(rangeStart === previous ? String(rangeStart) : `${rangeStart}-${previous}`);
        rangeStart = pageNumber;
        previous = pageNumber;
    }

    if (rangeStart !== null && previous !== null) {
        ranges.push(rangeStart === previous ? String(rangeStart) : `${rangeStart}-${previous}`);
    }

    return ranges.join(',');
}

async function writeQpdfArgsFile(args: string[]) {
    const tempDir = await mkdtemp(join(tmpdir(), 'qpdfArgs-'));
    const argsPath = join(tempDir, 'args.txt');
    await writeFile(argsPath, args.map(arg => arg.replace(/\r?\n/g, ' ')).join('\n'));
    return {
        argsPath,
        cleanup: async () => {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        },
    };
}

async function prepareSourcePdfForExport(pdfPath: string, options: IExportPdfOptions): Promise<IPreparedSourcePdf> {
    const normalizedPages = normalizePageNumbers(options.pageNumbers);

    if (!normalizedPages) {
        return {
            pdfPath,
            cleanup: async () => {},
        };
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'pdfExport-scope-'));
    const subsetPdfPath = join(tempDir, 'subset.pdf');
    const qpdf = getNativeToolPaths().qpdf;

    try {
        throwIfAborted(options.signal);
        const qpdfArgs = [
            pdfPath,
            '--pages',
            pdfPath,
            formatPageList(normalizedPages),
            '--',
            subsetPdfPath,
        ];
        const argsFile = await writeQpdfArgsFile(qpdfArgs);
        try {
            await runNativeToolCommand(qpdf, [`@${argsFile.argsPath}`], {
                timeoutMs: QPDF_TIMEOUT_MS,
                commandLabel: 'qpdf(export-subset)',
                ...(options.signal ? { signal: options.signal } : {}),
            });
        } finally {
            await argsFile.cleanup();
        }

        return {
            pdfPath: subsetPdfPath,
            cleanup: async () => {
                await rm(tempDir, {
                    recursive: true,
                    force: true,
                });
            },
        };
    } catch (error) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
        throw error;
    }
}

function createPageRanges(pageCount: number) {
    return range(1, pageCount + 1, PDF_EXPORT_RENDER_CHUNK_PAGES)
        .map(firstPage => ({
            firstPage,
            lastPage: Math.min(pageCount, firstPage + PDF_EXPORT_RENDER_CHUNK_PAGES - 1),
        }));
}

export async function exportPdfPagesAsImages(
    pdfPath: string,
    outputTemplatePath: string,
    options: IExportPdfOptions = {},
): Promise<string[]> {
    const {
        normalizedPath,
        format,
    } = normalizeImageExportPath(outputTemplatePath);

    const outputDirectory = dirname(normalizedPath);
    const outputStem = basename(normalizedPath, extname(normalizedPath));
    const outputExtension = resolveFormatExtension(format);

    await mkdir(outputDirectory, { recursive: true });

    const preparedSourcePdf = await prepareSourcePdfForExport(pdfPath, options);

    try {
        const pageCount = options.pageNumbers
            ? normalizePageNumbers(options.pageNumbers)!.length
            : await getPdfPageCount(preparedSourcePdf.pdfPath);
        assertExportPageCountWithinLimit(pageCount);

        const stagedFiles: Array<{
            stagedPath: string;
            targetPath: string;
            targetExisted: boolean;
        }> = [];
        const exportedPaths: string[] = [];
        const isSinglePageExport = pageCount === 1;
        try {
            for (const pageRange of createPageRanges(pageCount)) {
                throwIfAborted(options.signal);
                const pageFiles = await renderPdfToTempPages(preparedSourcePdf.pdfPath, format, pageRange, options.signal);

                try {
                    for (const source of pageFiles) {
                        const outputIndex = exportedPaths.length + 1;
                        const targetPath = isSinglePageExport
                            ? normalizedPath
                            : join(
                                outputDirectory,
                                `${outputStem}-${String(outputIndex).padStart(3, '0')}${outputExtension}`,
                            );
                        const stagedPath = makeSiblingTempPath(targetPath);

                        throwIfAborted(options.signal);
                        await moveFile(source.path, stagedPath);
                        stagedFiles.push({
                            stagedPath,
                            targetPath,
                            targetExisted: existsSync(targetPath),
                        });
                        exportedPaths.push(targetPath);
                    }
                } finally {
                    const tempDir = dirname(pageFiles[0]!.path);
                    await rm(tempDir, {
                        recursive: true,
                        force: true,
                    });
                }
            }
            throwIfAborted(options.signal);
            await promoteStagedFiles(stagedFiles);
        } catch (error) {
            await Promise.all(stagedFiles.map(stagedFile => rm(stagedFile.stagedPath, { force: true }).catch(() => undefined)));
            throw error;
        }
        return exportedPaths;
    } finally {
        await preparedSourcePdf.cleanup();
    }
}

function resolveTiffCombineWorkerPath() {
    return resolveUnpackedWorkerPath(__dirname, TIFF_COMBINE_WORKER_FILENAME);
}

class TiffCombineWorkerStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TiffCombineWorkerStartupError';
    }
}

async function canUseLocalTiffCombineFallback(pagePaths: string[]) {
    if (pagePaths.length > TIFF_COMBINE_LOCAL_FALLBACK_MAX_PAGES) {
        return false;
    }

    let totalBytes = 0;
    for (const pagePath of pagePaths) {
        const pageStat = await stat(pagePath);
        if (!pageStat.isFile()) {
            return false;
        }

        totalBytes += pageStat.size;
        if (totalBytes > TIFF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES) {
            return false;
        }
    }

    return true;
}

function getTiffCombineFallbackDisabledError() {
    const maxMb = Math.floor(TIFF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES / (1024 * 1024));
    return new Error(
        `TIFF combine worker unavailable and local fallback is disabled for exports larger than ${TIFF_COMBINE_LOCAL_FALLBACK_MAX_PAGES} pages or ${maxMb}MB`,
    );
}

async function runLocalTiffCombine(pagePaths: string[], outputPath: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    await measureElectronPerfAsync('image-export:tiffCombineLocal', () => combinePagesIntoMultiPageTiffLocal(pagePaths, outputPath), {
        thresholdMs: 25,
        details: {
            pageCount: pagePaths.length,
            outputPath,
        },
    });
    throwIfAborted(signal);
}

async function combinePagesIntoMultiPageTiff(pagePaths: string[], outputPath: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const tempOutputPath = makeSiblingTempPath(outputPath);
    let replacedOutput = false;

    const workerPath = resolveTiffCombineWorkerPath();

    try {
        if (!existsSync(workerPath)) {
            if (!(await canUseLocalTiffCombineFallback(pagePaths))) {
                logger.warn(`TIFF combine worker unavailable, refusing unsafe local fallback at ${workerPath}`);
                throw getTiffCombineFallbackDisabledError();
            }

            logger.warn(`TIFF combine worker unavailable, falling back to local combine: missing worker at ${workerPath}`);
            await runLocalTiffCombine(pagePaths, tempOutputPath, signal);
            throwIfAborted(signal);
            await atomicReplace(tempOutputPath, outputPath);
            replacedOutput = true;
            return;
        }

        try {
            await measureElectronPerfAsync('image-export:tiffCombineWorker', () => runResultWorkerTask<undefined>({
                workerPath,
                workerData: {
                    pagePaths,
                    outputPath: tempOutputPath,
                },
                invalidPayloadMessage: 'TIFF combine worker returned an invalid payload',
                createStartError: message => new TiffCombineWorkerStartupError(
                    `TIFF combine worker failed to start: ${message}`,
                ),
                createStartupError: message => new TiffCombineWorkerStartupError(
                    `TIFF combine worker failed before becoming ready: ${message}`,
                ),
                createStartupExitError: code => new TiffCombineWorkerStartupError(
                    `TIFF combine worker exited during startup with code ${code}`,
                ),
                createWorkerExitError: code => new Error(`TIFF combine worker exited with code ${code}`),
                ...(signal ? { signal } : {}),
                timeoutMs: TIFF_COMBINE_WORKER_TIMEOUT_MS,
            }), {
                thresholdMs: 25,
                details: {
                    pageCount: pagePaths.length,
                    outputPath,
                },
            });
        } catch (error) {
            if (!(error instanceof TiffCombineWorkerStartupError)) {
                throw error;
            }

            if (!(await canUseLocalTiffCombineFallback(pagePaths))) {
                logger.warn(`TIFF combine worker unavailable, refusing unsafe local fallback: ${error.message}`);
                throw getTiffCombineFallbackDisabledError();
            }

            logger.warn(`TIFF combine worker unavailable, falling back to local combine: ${error.message}`);
            await runLocalTiffCombine(pagePaths, tempOutputPath, signal);
        }

        throwIfAborted(signal);
        await atomicReplace(tempOutputPath, outputPath);
        replacedOutput = true;
    } finally {
        if (!replacedOutput) {
            await rm(tempOutputPath, { force: true }).catch(() => undefined);
        }
    }
}

export async function exportPdfAsMultiPageTiff(
    pdfPath: string,
    outputPath: string,
    options: IExportPdfOptions = {},
) {
    const targetPath = outputPath.toLowerCase().endsWith('.tif') || outputPath.toLowerCase().endsWith('.tiff')
        ? outputPath
        : `${outputPath}.tiff`;

    const outputDirectory = dirname(targetPath);
    await mkdir(outputDirectory, { recursive: true });

    const preparedSourcePdf = await prepareSourcePdfForExport(pdfPath, options);

    try {
        const pageCount = options.pageNumbers
            ? normalizePageNumbers(options.pageNumbers)!.length
            : await getPdfPageCount(preparedSourcePdf.pdfPath);
        assertExportPageCountWithinLimit(pageCount);
        const pageFiles: IRenderedPageFile[] = [];

        try {
            for (const pageRange of createPageRanges(pageCount)) {
                throwIfAborted(options.signal);
                pageFiles.push(...await renderPdfToTempPages(preparedSourcePdf.pdfPath, 'tiff', pageRange, options.signal));
            }

            const orderedPagePaths = pageFiles
                .sort((left, right) => left.page - right.page)
                .map(pageFile => pageFile.path);

            await combinePagesIntoMultiPageTiff(orderedPagePaths, targetPath, options.signal);

            if (!existsSync(targetPath)) {
                throw new Error('Multi-page TIFF export did not produce an output file');
            }

            return targetPath;
        } finally {
            await Promise.all(uniq(pageFiles.map(pageFile => dirname(pageFile.path))).map(tempDir => rm(tempDir, {
                recursive: true,
                force: true,
            })));
        }
    } finally {
        await preparedSourcePdf.cleanup();
    }
}
