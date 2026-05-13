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
import { uniq } from 'es-toolkit/array';
import { getNativeToolPaths } from '@electron/native-tools/paths';
import {
    detectSourceDpi,
    clampDpi,
} from '@electron/ocr/worker/dpiDetection';
import { runNativeToolCommand } from '@electron/native-tools/exec';
import { createLogger } from '@electron/utils/logger';
import { measureElectronPerfAsync } from '@electron/utils/devPerf';
import { combinePagesIntoMultiPageTiffLocal } from '@electron/features/image-export/main/tiffCombineLocal';
import {
    resolveUnpackedWorkerPath,
    runResultWorkerTask,
} from '@electron/utils/workerTask';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';

type TImageExportFormat = 'png' | 'jpeg' | 'tiff';

interface IRenderedPageFile {
    page: number;
    path: string;
}

interface IExportPdfOptions {pageNumbers?: number[];}

interface IPreparedSourcePdf {
    pdfPath: string;
    cleanup: () => Promise<void>;
}

const logger = createLogger('image-export');
const __dirname = dirnameFromPath(fileURLToPath(import.meta.url));
const PDFTOPPM_TIMEOUT_MS = 3 * 60 * 1000;
const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const TIFF_COMBINE_WORKER_TIMEOUT_MS = 10 * 60 * 1000;
const TIFF_COMBINE_WORKER_FILENAME = 'image-export-tiff-worker.js';
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

function resolveFormatExtension(format: TImageExportFormat): string {
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

function toPdftoppmFormatArg(format: TImageExportFormat): string {
    if (format === 'jpeg') {
        return '-jpeg';
    }
    if (format === 'tiff') {
        return '-tiff';
    }
    return '-png';
}

function parsePageNumber(fileName: string): number {
    const match = fileName.match(/-(\d+)\.[^.]+$/);
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }
    return Number.parseInt(match[1] ?? '', 10);
}

function isExpectedPageFile(fileName: string, format: TImageExportFormat): boolean {
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
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EXDEV') {
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

async function renderPdfToTempPages(pdfPath: string, format: TImageExportFormat): Promise<IRenderedPageFile[]> {
    const tempDir = await mkdtemp(join(tmpdir(), 'pdfExport-'));
    const prefix = join(tempDir, 'page');
    const paths = getNativeToolPaths();

    const detectedDpi = await detectSourceDpi(
        pdfPath,
        paths.pdfimages,
        (level, message) => logger[level === 'error' ? 'error' : 'debug'](message),
    );
    const renderDpi = clampDpi(detectedDpi ?? 300);

    try {
        await runNativeToolCommand(paths.pdftoppm, [
            toPdftoppmFormatArg(format),
            '-r',
            String(renderDpi),
            pdfPath,
            prefix,
        ], {
            timeoutMs: PDFTOPPM_TIMEOUT_MS,
            commandLabel: `pdftoppm(export-${format})`,
        });

        const fileNames = await readdir(tempDir);
        const pageFiles = fileNames
            .filter(fileName => fileName.startsWith('page-'))
            .filter(fileName => isExpectedPageFile(fileName, format))
            .sort((left, right) => parsePageNumber(left) - parsePageNumber(right))
            .map((fileName) => ({
                page: parsePageNumber(fileName),
                path: join(tempDir, fileName),
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

function formatPageList(pageNumbers: number[]): string {
    return pageNumbers.join(',');
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
        await runNativeToolCommand(qpdf, [
            pdfPath,
            '--pages',
            pdfPath,
            formatPageList(normalizedPages),
            '--',
            subsetPdfPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            commandLabel: 'qpdf(export-subset)',
        });

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
        const pageFiles = await renderPdfToTempPages(preparedSourcePdf.pdfPath, format);

        try {
            const exportedPaths: string[] = [];
            const isSinglePageExport = pageFiles.length === 1;

            for (let index = 0; index < pageFiles.length; index += 1) {
                const source = pageFiles[index]!;

                const targetPath = isSinglePageExport
                    ? normalizedPath
                    : join(
                        outputDirectory,
                        `${outputStem}-${String(index + 1).padStart(3, '0')}${outputExtension}`,
                    );

                await moveFile(source.path, targetPath);
                exportedPaths.push(targetPath);
            }

            return exportedPaths;
        } finally {
            const tempDir = dirname(pageFiles[0]!.path);
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
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

async function runLocalTiffCombine(pagePaths: string[], outputPath: string) {
    await measureElectronPerfAsync('image-export:tiffCombineLocal', () => combinePagesIntoMultiPageTiffLocal(pagePaths, outputPath), {
        thresholdMs: 25,
        details: {
            pageCount: pagePaths.length,
            outputPath,
        },
    });
}

async function combinePagesIntoMultiPageTiff(pagePaths: string[], outputPath: string) {
    const workerPath = resolveTiffCombineWorkerPath();
    if (!existsSync(workerPath)) {
        if (!(await canUseLocalTiffCombineFallback(pagePaths))) {
            logger.warn(`TIFF combine worker unavailable, refusing unsafe local fallback at ${workerPath}`);
            throw getTiffCombineFallbackDisabledError();
        }

        logger.warn(`TIFF combine worker unavailable, falling back to local combine: missing worker at ${workerPath}`);
        await runLocalTiffCombine(pagePaths, outputPath);
        return;
    }

    try {
        await measureElectronPerfAsync('image-export:tiffCombineWorker', () => runResultWorkerTask<undefined>({
            workerPath,
            workerData: {
                pagePaths,
                outputPath,
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
        await runLocalTiffCombine(pagePaths, outputPath);
    }
}

export async function exportPdfAsMultiPageTiff(
    pdfPath: string,
    outputPath: string,
    options: IExportPdfOptions = {},
): Promise<string> {
    const targetPath = outputPath.toLowerCase().endsWith('.tif') || outputPath.toLowerCase().endsWith('.tiff')
        ? outputPath
        : `${outputPath}.tiff`;

    const outputDirectory = dirname(targetPath);
    await mkdir(outputDirectory, { recursive: true });

    const preparedSourcePdf = await prepareSourcePdfForExport(pdfPath, options);

    try {
        const pageFiles = await renderPdfToTempPages(preparedSourcePdf.pdfPath, 'tiff');

        try {
            const orderedPagePaths = pageFiles
                .sort((left, right) => left.page - right.page)
                .map(pageFile => pageFile.path);

            await combinePagesIntoMultiPageTiff(orderedPagePaths, targetPath);

            if (!existsSync(targetPath)) {
                throw new Error('Multi-page TIFF export did not produce an output file');
            }

            return targetPath;
        } finally {
            const tempDir = dirname(pageFiles[0]!.path);
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    } finally {
        await preparedSourcePdf.cleanup();
    }
}
