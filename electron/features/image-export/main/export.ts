import {existsSync} from 'fs';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
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
import {
    clamp,
    range,
} from 'es-toolkit/math';
import { encode as encodePng } from 'fast-png';
import { isErrnoException } from '@contracts/runtimeGuards';
import type { TImageExportProgressPhase } from '@contracts/electronApiDocuments';
import { getNativeToolPaths } from '@electron/native-tools/getNativeToolPaths';
import {
    buildPopplerEnv,
    type IPopplerRuntimePaths,
} from '@electron/native-tools/buildPopplerEnv';
import { clampDpi } from '@electron/ocr/worker/dpiDetection';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { createLogger } from '@electron/utils/createLogger';
import { measureElectronPerfAsync } from '@electron/utils/measureElectronPerfAsync';
import {
    combinePagesIntoMultiPageTiffLocal,
    readTiffPageDescriptors,
    splitTiffPageDescriptorsForClassicLimit,
} from '@electron/features/image-export/main/combinePagesIntoMultiPageTiffLocal';
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
import {
    isNativePdfImageCombineDisabled,
    resolveNativePdfImageCombinePath,
} from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { getErrorMessage } from '@electron/utils/error';

type TImageExportFormat = 'png' | 'jpeg' | 'tiff';
type TPageRenderFormat = TImageExportFormat | 'ppm';

interface IRenderedPageFile {
    page: number;
    path: string;
}

interface IExportPdfOptions {
    pageNumbers?: number[];
    signal?: AbortSignal;
    onProgress?: (progress: IImageExportProgressUpdate) => void;
}

interface IImageExportProgressUpdate {
    phase: TImageExportProgressPhase;
    processed: number;
    total: number;
    percent?: number;
}

interface IPreparedSourcePdf {
    pdfPath: string;
    cleanup: () => Promise<void>;
}

interface IExportPageRange {
    firstPage: number;
    lastPage: number;
}

const logger = createLogger('image-export');
const __dirname = dirnameFromPath(fileURLToPath(import.meta.url));
const PDFIMAGES_DPI_PROBE_TIMEOUT_MS = 30 * 1000;
const PDFTOPPM_TIMEOUT_MS = 3 * 60 * 1000;
const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const PDF_EXPORT_MAX_PAGES = parseIntegerEnv('EVB_PDF_IMAGE_EXPORT_MAX_PAGES', 500, 1, 10_000);
const PDF_EXPORT_RENDER_CHUNK_PAGES = parseIntegerEnv('EVB_PDF_IMAGE_EXPORT_RENDER_CHUNK_PAGES', 25, 1, 100);
const PDF_EXPORT_PNG_RENDER_CHUNK_PAGES = parseIntegerEnv('EVB_PDF_IMAGE_EXPORT_PNG_RENDER_CHUNK_PAGES', 5, 1, 25);
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

function toPdftoppmFormatArgs(format: TPageRenderFormat) {
    if (format === 'jpeg') {
        return ['-jpeg'];
    }
    if (format === 'tiff') {
        return ['-tiff'];
    }
    if (format === 'png') {
        return ['-png'];
    }
    return [];
}

function parsePageNumber(fileName: string) {
    const match = fileName.match(/-(\d+)\.[^.]+$/);
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }
    return Number.parseInt(match[1] ?? '', 10);
}

function isExpectedPageFile(fileName: string, format: TPageRenderFormat) {
    const extension = extname(fileName).toLowerCase();

    if (format === 'jpeg') {
        return extension === '.jpg' || extension === '.jpeg';
    }
    if (format === 'tiff') {
        return extension === '.tif' || extension === '.tiff';
    }
    if (format === 'ppm') {
        return extension === '.ppm';
    }

    return extension === '.png';
}

function readPnmToken(bytes: Uint8Array, cursor: { offset: number }) {
    while (cursor.offset < bytes.length) {
        const byte = bytes[cursor.offset];
        if (byte === 0x23) {
            while (cursor.offset < bytes.length && bytes[cursor.offset] !== 0x0A) {
                cursor.offset += 1;
            }
            continue;
        }
        if (byte !== undefined && byte <= 0x20) {
            cursor.offset += 1;
            continue;
        }
        break;
    }

    const start = cursor.offset;
    while (cursor.offset < bytes.length) {
        const byte = bytes[cursor.offset];
        if (byte === undefined || byte <= 0x20) {
            break;
        }
        cursor.offset += 1;
    }

    if (start === cursor.offset) {
        throw new Error('Invalid PPM image header');
    }

    return Buffer.from(bytes.buffer, bytes.byteOffset + start, cursor.offset - start).toString('ascii');
}

function parsePositivePnmInteger(value: string, label: string) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid PPM ${label}`);
    }
    return parsed;
}

function parseRawPpm(bytes: Uint8Array) {
    const cursor = { offset: 0 };
    const magic = readPnmToken(bytes, cursor);
    if (magic !== 'P6') {
        throw new Error(`Unsupported PPM image type: ${magic}`);
    }

    const width = parsePositivePnmInteger(readPnmToken(bytes, cursor), 'width');
    const height = parsePositivePnmInteger(readPnmToken(bytes, cursor), 'height');
    const maxValue = parsePositivePnmInteger(readPnmToken(bytes, cursor), 'max value');
    if (maxValue !== 255) {
        throw new Error(`Unsupported PPM max value: ${maxValue}`);
    }

    if (cursor.offset < bytes.length) {
        const separator = bytes[cursor.offset];
        if (separator !== undefined && separator <= 0x20) {
            cursor.offset += 1;
        }
    }

    const expectedByteLength = width * height * 3;
    const data = bytes.subarray(cursor.offset);
    if (data.length !== expectedByteLength) {
        throw new Error(`Invalid PPM pixel data length: expected ${expectedByteLength}, found ${data.length}`);
    }

    return {
        width,
        height,
        data,
    };
}

function createLosslessGrayscaleData(data: Uint8Array) {
    const grayscaleData = new Uint8Array(data.length / 3);
    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < data.length; sourceIndex += 3, targetIndex += 1) {
        const red = data[sourceIndex];
        const green = data[sourceIndex + 1];
        const blue = data[sourceIndex + 2];
        if (red === undefined || green === undefined || blue === undefined || red !== green || red !== blue) {
            return null;
        }
        grayscaleData[targetIndex] = red;
    }
    return grayscaleData;
}

async function tryConvertRenderedPpmToPngNative(sourcePath: string, pngPath: string) {
    if (isNativePdfImageCombineDisabled()) {
        return false;
    }

    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        return false;
    }

    try {
        await runNativeToolCommand(binaryPath, [
            '--format',
            'png',
            '--output',
            pngPath,
            '--',
            sourcePath,
        ], {
            timeoutMs: PDFTOPPM_TIMEOUT_MS,
            commandLabel: 'evb-pdf-image-combine(ppm-to-png)',
        });
        await unlink(sourcePath).catch(() => undefined);
        return true;
    } catch (error) {
        logger.debug(`Native PPM-to-PNG conversion failed, falling back to JS encoder: ${getErrorMessage(error)}`);
        await rm(pngPath, {force: true}).catch(() => undefined);
        return false;
    }
}

async function convertRenderedPpmToPng(sourcePath: string) {
    const pngPath = sourcePath.replace(/\.ppm$/i, '.png');
    if (await tryConvertRenderedPpmToPngNative(sourcePath, pngPath)) {
        return pngPath;
    }

    const sourceBytes = await readFile(sourcePath);
    const image = parseRawPpm(sourceBytes);
    const grayscaleData = createLosslessGrayscaleData(image.data);
    const pngBytes = encodePng({
        width: image.width,
        height: image.height,
        channels: grayscaleData ? 1 : 3,
        depth: 8,
        data: grayscaleData ?? image.data,
    });
    await writeFile(pngPath, pngBytes);
    await unlink(sourcePath).catch(() => undefined);
    return pngPath;
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

function parsePdfImagesListDpi(output: string) {
    let detectedDpi = 0;
    for (const line of output.split(/\r?\n/u)) {
        const parts = line.trim().split(/\s+/u);
        if (parts.length < 14) {
            continue;
        }

        const xPpi = Number.parseInt(parts[12] ?? '', 10);
        const yPpi = Number.parseInt(parts[13] ?? '', 10);
        const dpi = Math.max(
            Number.isFinite(xPpi) ? xPpi : 0,
            Number.isFinite(yPpi) ? yPpi : 0,
        );
        if (dpi > 0) {
            detectedDpi = Math.max(detectedDpi, dpi);
        }
    }

    return detectedDpi > 0 ? detectedDpi : null;
}

async function detectExportDpi(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    popplerRuntimePaths: IPopplerRuntimePaths,
    pageRange: IExportPageRange,
    signal?: AbortSignal,
) {
    if (!pdfimagesBinary) {
        return null;
    }

    throwIfAborted(signal);
    try {
        const popplerEnv = buildPopplerEnv(popplerRuntimePaths);
        const commandOptions: Parameters<typeof runNativeToolCommand>[2] = {
            timeoutMs: PDFIMAGES_DPI_PROBE_TIMEOUT_MS,
            commandLabel: 'pdfimages(export-dpi)',
            ...(signal ? { signal } : {}),
        };
        if (popplerEnv !== undefined) {
            commandOptions.env = popplerEnv;
        }

        const result = await runNativeToolCommand(pdfimagesBinary, [
            '-f',
            String(pageRange.firstPage),
            '-l',
            String(pageRange.lastPage),
            '-list',
            pdfPath,
        ], commandOptions);
        return parsePdfImagesListDpi(result.stdout);
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : error;
        }

        logger.debug(
            `pdfimages export DPI probe failed for pages ${pageRange.firstPage}-${pageRange.lastPage}: ${getErrorMessage(error)}`,
        );
        return null;
    }
}

export async function getPdfPageCount(pdfPath: string) {
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

function emitExportProgress(options: IExportPdfOptions, progress: IImageExportProgressUpdate) {
    const total = Math.max(1, Math.trunc(progress.total));
    const processed = clamp(Math.trunc(progress.processed), 0, total);
    options.onProgress?.({
        phase: progress.phase,
        processed,
        total,
        percent: clamp(progress.percent ?? ((processed / total) * 100), 0, 100),
    });
}

async function renderPdfToTempPages(
    pdfPath: string,
    format: TImageExportFormat,
    pageRange: IExportPageRange,
    signal?: AbortSignal,
): Promise<IRenderedPageFile[]> {
    const tempDir = await mkdtemp(join(tmpdir(), 'pdfExport-'));
    const prefix = join(tempDir, 'page');
    const paths = getNativeToolPaths();
    throwIfAborted(signal);

    try {
        const detectedDpi = await detectExportDpi(
            pdfPath,
            paths.pdfimages,
            paths,
            pageRange,
            signal,
        );
        const renderDpi = clampDpi(detectedDpi ?? 300);

        throwIfAborted(signal);
        const renderFormat: TPageRenderFormat = format === 'png' ? 'ppm' : format;
        const popplerEnv = buildPopplerEnv(paths);
        const commandOptions: Parameters<typeof runNativeToolCommand>[2] = {
            timeoutMs: PDFTOPPM_TIMEOUT_MS,
            commandLabel: `pdftoppm(export-${format})`,
            ...(signal ? { signal } : {}),
        };
        if (popplerEnv !== undefined) {
            commandOptions.env = popplerEnv;
        }

        await runNativeToolCommand(paths.pdftoppm, [
            ...toPdftoppmFormatArgs(renderFormat),
            '-r',
            String(renderDpi),
            '-f',
            String(pageRange.firstPage),
            '-l',
            String(pageRange.lastPage),
            pdfPath,
            prefix,
        ], commandOptions);
        throwIfAborted(signal);

        const fileNames = await readdir(tempDir);
        const pageFiles = sortBy(
            fileNames
                .filter(fileName => fileName.startsWith('page-'))
                .filter(fileName => isExpectedPageFile(fileName, renderFormat))
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

        if (renderFormat === 'ppm') {
            for (const pageFile of pageFiles) {
                throwIfAborted(signal);
                pageFile.path = await convertRenderedPpmToPng(pageFile.path);
            }
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

function getRequestedPageCount(options: IExportPdfOptions) {
    const normalizedPages = normalizePageNumbers(options.pageNumbers);
    return normalizedPages?.length ?? null;
}

function getRenderedPageTempDir(pageFiles: IRenderedPageFile[]) {
    const firstPageFile = pageFiles[0];
    if (!firstPageFile) {
        throw new Error('No page images were generated from the PDF');
    }
    return dirname(firstPageFile.path);
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

function createPageRanges(pageCount: number, chunkPages = PDF_EXPORT_RENDER_CHUNK_PAGES) {
    return range(1, pageCount + 1, chunkPages)
        .map(firstPage => ({
            firstPage,
            lastPage: Math.min(pageCount, firstPage + chunkPages - 1),
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
        const requestedPageCount = getRequestedPageCount(options);
        const pageCount = requestedPageCount ?? await getPdfPageCount(preparedSourcePdf.pdfPath);
        assertExportPageCountWithinLimit(pageCount);

        const stagedFiles: Array<{
            stagedPath: string;
            targetPath: string;
            targetExisted: boolean;
        }> = [];
        const exportedPaths: string[] = [];
        const isSinglePageExport = pageCount === 1;
        let processedPages = 0;
        emitExportProgress(options, {
            phase: 'rendering',
            processed: 0,
            total: pageCount,
        });

        try {
            for (const pageRange of createPageRanges(
                pageCount,
                format === 'png' ? PDF_EXPORT_PNG_RENDER_CHUNK_PAGES : PDF_EXPORT_RENDER_CHUNK_PAGES,
            )) {
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
                        processedPages += 1;
                        emitExportProgress(options, {
                            phase: 'rendering',
                            processed: processedPages,
                            total: pageCount,
                        });
                    }
                } finally {
                    const tempDir = getRenderedPageTempDir(pageFiles);
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

function decodeUndefinedWorkerResult(data: unknown): undefined | null {
    return data === undefined ? undefined : null;
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

function buildMultiPageTiffOutputPaths(targetPath: string, partCount: number) {
    if (partCount <= 1) {
        return [targetPath];
    }

    const outputDirectory = dirname(targetPath);
    const outputExtension = extname(targetPath) || '.tiff';
    const outputStem = basename(targetPath, outputExtension);

    return range(1, partCount + 1).map(partNumber =>
        join(
            outputDirectory,
            `${outputStem}-part-${String(partNumber).padStart(3, '0')}${outputExtension}`,
        ),
    );
}

async function runLocalTiffCombine(pagePaths: string[], outputPath: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    await measureElectronPerfAsync('image-export:tiffCombineLocal', () => combinePagesIntoMultiPageTiffLocal(pagePaths, outputPath, signal), {
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
                decodeResult: decodeUndefinedWorkerResult,
                invalidResultMessage: 'TIFF combine worker returned an invalid result',
                ...(signal ? { signal } : {}),
                createCancelMessage: () => ({type: 'cancel'}),
                cooperativeCancelDelayMs: 1_500,
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
        const requestedPageCount = getRequestedPageCount(options);
        const pageCount = requestedPageCount ?? await getPdfPageCount(preparedSourcePdf.pdfPath);
        assertExportPageCountWithinLimit(pageCount);
        const pageFiles: IRenderedPageFile[] = [];
        let renderedPageCount = 0;
        emitExportProgress(options, {
            phase: 'rendering',
            processed: 0,
            total: pageCount,
            percent: 0,
        });

        try {
            for (const pageRange of createPageRanges(pageCount)) {
                throwIfAborted(options.signal);
                const renderedPageFiles = await renderPdfToTempPages(preparedSourcePdf.pdfPath, 'tiff', pageRange, options.signal);
                pageFiles.push(...renderedPageFiles);
                renderedPageCount += renderedPageFiles.length;
                emitExportProgress(options, {
                    phase: 'rendering',
                    processed: renderedPageCount,
                    total: pageCount,
                    percent: (renderedPageCount / pageCount) * 90,
                });
            }

            const orderedPagePaths = pageFiles
                .sort((left, right) => left.page - right.page)
                .map(pageFile => pageFile.path);
            const tiffPageDescriptors = await readTiffPageDescriptors(orderedPagePaths);
            const tiffPageGroups = splitTiffPageDescriptorsForClassicLimit(tiffPageDescriptors)
                .map(group => group.map(page => page.path));
            const outputPaths = buildMultiPageTiffOutputPaths(targetPath, tiffPageGroups.length);
            emitExportProgress(options, {
                phase: 'combining',
                processed: 0,
                total: Math.max(1, tiffPageGroups.length),
                percent: 90,
            });
            const stagedFiles: Array<{
                stagedPath: string;
                targetPath: string;
                targetExisted: boolean;
            }> = [];

            try {
                for (const [
                    index,
                    tiffPageGroup,
                ] of tiffPageGroups.entries()) {
                    throwIfAborted(options.signal);
                    const targetOutputPath = outputPaths[index];
                    if (!targetOutputPath) {
                        throw new Error('Multi-page TIFF export target path is missing');
                    }
                    const stagedPath = makeSiblingTempPath(targetOutputPath);
                    await combinePagesIntoMultiPageTiff(tiffPageGroup, stagedPath, options.signal);
                    stagedFiles.push({
                        stagedPath,
                        targetPath: targetOutputPath,
                        targetExisted: existsSync(targetOutputPath),
                    });
                    emitExportProgress(options, {
                        phase: 'combining',
                        processed: index + 1,
                        total: tiffPageGroups.length,
                        percent: 90 + (((index + 1) / tiffPageGroups.length) * 10),
                    });
                }
                throwIfAborted(options.signal);
                await promoteStagedFiles(stagedFiles);
            } catch (error) {
                await Promise.all(stagedFiles.map(stagedFile => rm(stagedFile.stagedPath, { force: true }).catch(() => undefined)));
                throw error;
            }

            for (const outputPath of outputPaths) {
                if (!existsSync(outputPath)) {
                    throw new Error('Multi-page TIFF export did not produce an output file');
                }
            }

            return outputPaths;
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
