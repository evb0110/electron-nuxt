import { randomUUID } from 'node:crypto';
import {
    copyFile,
    mkdir,
    rm,
    stat,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    extname,
    join,
} from 'node:path';
import type { IImageExportProgress } from '@contracts/electronApiDocuments';
import { getDjvuPageCount } from '@electron/djvu/metadata';
import {
    convertDjvuPageToImage,
    getDjvuPageSizesForViewing,
} from '@electron/features/djvu/public';
import {
    convertRenderedPpmToPng,
    promoteStagedFiles,
} from '@electron/features/image-export/main/export';
import { tryCombinePagesWithNativeTiffCombiner } from '@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner';
import { makeSiblingTempPath } from '@electron/utils/atomicReplace';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { mainJobBroker } from '@electron/resources/jobBroker';
import {
    type TManagedScratchPrefix,
    usingManagedScratchScope,
} from '@electron/utils/managedScratchTemp';

interface IDjvuImageExportOptions {
    pageNumbers?: number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    onProgress?: (progress: Pick<IImageExportProgress, 'phase' | 'processed' | 'total' | 'percent'>) => void;
    scratch?: {using<T>(prefix: TManagedScratchPrefix, run: (scratchPath: string) => Promise<T>): Promise<T>;};
}

const DJVU_EXPORT_MAX_EDGE_PIXELS = 8_192;
const DJVU_EXPORT_MAX_PAGE_PIXELS = 80_000_000;
const DJVU_PNG_EXPORT_MAX_TOTAL_PIXELS = 2_000_000_000;
const DJVU_TIFF_EXPORT_MAX_TOTAL_PIXELS = 256_000_000;
const DJVU_EXPORT_MAX_STAGED_BYTES = 2 * 1024 * 1024 * 1024;

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortErrorFromSignal(signal);
}

function usingDjvuScratch<T>(
    options: IDjvuImageExportOptions,
    prefix: TManagedScratchPrefix,
    run: (scratchPath: string) => Promise<T>,
) {
    return (options.scratch?.using ?? usingManagedScratchScope)(prefix, run);
}

async function resolvePages(path: string, requested: number[] | undefined, signal?: AbortSignal) {
    const pageCount = await getDjvuPageCount(path, {...(signal ? {signal} : {})});
    const pages = requested ?? Array.from({length: pageCount}, (_, index) => index + 1);
    if (pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
        throw new Error(`DjVu export page numbers must be between 1 and ${pageCount}`);
    }
    return {
        pageCount,
        pages,
    };
}

async function assertDjvuExportRasterBudget(
    djvuPath: string,
    pageCount: number,
    pages: readonly number[],
    maxTotalPixels: number,
    signal?: AbortSignal,
) {
    const sizes = await getDjvuPageSizesForViewing(djvuPath, pageCount, signal ? {signal} : {});
    let totalPixels = 0;
    for (const page of pages) {
        const size = sizes[page - 1];
        if (!size) throw new Error(`DjVu page ${page} dimensions are unavailable`);
        const pixels = size.width * size.height;
        if (
            size.width > DJVU_EXPORT_MAX_EDGE_PIXELS
            || size.height > DJVU_EXPORT_MAX_EDGE_PIXELS
            || pixels > DJVU_EXPORT_MAX_PAGE_PIXELS
        ) {
            throw new Error(`DjVu page ${page} exceeds the image export raster limit`);
        }
        totalPixels += pixels;
        if (totalPixels > maxTotalPixels) {
            throw new Error(`DjVu image export exceeds the ${maxTotalPixels} aggregate-pixel limit`);
        }
    }
}

function buildPngOutputPaths(templatePath: string, pages: number[]) {
    const outputDirectory = dirname(templatePath);
    const extension = extname(templatePath);
    const stem = basename(templatePath, extension);
    if (pages.length === 1) {
        return [join(outputDirectory, `${stem}.png`)];
    }
    return pages.map(page => join(outputDirectory, `${stem}-page-${String(page).padStart(3, '0')}.png`));
}

async function renderDjvuPngPages(
    djvuPath: string,
    outputPaths: string[],
    pages: number[],
    options: IDjvuImageExportOptions,
) {
    return usingDjvuScratch(options, 'djvu-image-export-', async tempDirectory => {
        let stagedBytes = 0;
        const stagedFiles: Array<{
            stagedPath: string;
            targetPath: string;
            targetExisted: boolean;
        }> = [];
        try {
            options.onProgress?.({
                phase: 'rendering',
                processed: 0,
                total: pages.length,
                percent: 0,
            });
            for (const [
                index,
                page,
            ] of pages.entries()) {
                throwIfAborted(options.signal);
                const brokerLease = await mainJobBroker.acquire({
                    ownerId: options.cancelGroup ?? `djvu-image-export:${djvuPath}`,
                    kind: 'djvu-image-export-page',
                    priority: 'user',
                    resources: {
                        cpuTokens: 1,
                        estimatedResidentBytes: 128 * 1024 * 1024,
                        nativeProcesses: 1,
                        ioWeight: 2,
                    },
                    ...(options.signal ? {signal: options.signal} : {}),
                });
                const ppmPath = join(tempDirectory, `page-${page}.ppm`);
                const pngPath = await (async () => {
                    const render = await convertDjvuPageToImage(
                        djvuPath,
                        ppmPath,
                        page,
                        `djvu-image-export-${randomUUID()}`,
                        {
                            format: 'ppm',
                            ...(options.signal ? {signal: options.signal} : {}),
                        },
                    );
                    if (!render.success) throw new Error(render.error ?? `Failed to render DjVu page ${page}`);
                    stagedBytes += render.fileSize;
                    if (stagedBytes > DJVU_EXPORT_MAX_STAGED_BYTES) {
                        throw new Error('DjVu PNG export exceeds the staged-byte limit');
                    }
                    return convertRenderedPpmToPng(ppmPath, options.signal, options.cancelGroup);
                })().finally(() => brokerLease.release());
                const outputPath = outputPaths[index];
                if (!outputPath) throw new Error('DjVu image export target is missing');
                await mkdir(dirname(outputPath), {recursive: true});
                const targetExisted = await stat(outputPath).then(() => true).catch(() => false);
                const sibling = makeSiblingTempPath(outputPath);
                try {
                    await copyFile(pngPath, sibling);
                    throwIfAborted(options.signal);
                    stagedFiles.push({
                        stagedPath: sibling,
                        targetPath: outputPath,
                        targetExisted,
                    });
                } catch (error) {
                    await rm(sibling, {force: true}).catch(() => undefined);
                    throw error;
                } finally {
                    await rm(ppmPath, {force: true}).catch(() => undefined);
                    await rm(pngPath, {force: true}).catch(() => undefined);
                }
                options.onProgress?.({
                    phase: 'rendering',
                    processed: index + 1,
                    total: pages.length,
                    percent: ((index + 1) / pages.length) * 100,
                });
            }
            throwIfAborted(options.signal);
            await promoteStagedFiles(stagedFiles, options.signal);
            return outputPaths;
        } finally {
            await Promise.all(stagedFiles.map(({stagedPath}) => rm(stagedPath, {force: true}).catch(() => undefined)));
        }
    });
}

export async function exportDjvuPagesAsPng(
    djvuPath: string,
    outputTemplatePath: string,
    options: IDjvuImageExportOptions = {},
) {
    const {
        pageCount,
        pages,
    } = await resolvePages(djvuPath, options.pageNumbers, options.signal);
    await assertDjvuExportRasterBudget(
        djvuPath,
        pageCount,
        pages,
        DJVU_PNG_EXPORT_MAX_TOTAL_PIXELS,
        options.signal,
    );
    return renderDjvuPngPages(djvuPath, buildPngOutputPaths(outputTemplatePath, pages), pages, options);
}

export async function exportDjvuAsMultiPageTiff(
    djvuPath: string,
    outputPath: string,
    options: IDjvuImageExportOptions = {},
) {
    const {
        pageCount,
        pages,
    } = await resolvePages(djvuPath, options.pageNumbers, options.signal);
    await assertDjvuExportRasterBudget(
        djvuPath,
        pageCount,
        pages,
        DJVU_TIFF_EXPORT_MAX_TOTAL_PIXELS,
        options.signal,
    );
    return usingDjvuScratch(options, 'djvu-tiff-export-', async tempDirectory => {
        const pagePaths: string[] = [];
        let stagedBytes = 0;
        for (const [
            index,
            page,
        ] of pages.entries()) {
            throwIfAborted(options.signal);
            const brokerLease = await mainJobBroker.acquire({
                ownerId: options.cancelGroup ?? `djvu-tiff-export:${djvuPath}`,
                kind: 'djvu-tiff-render-page',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 128 * 1024 * 1024,
                    nativeProcesses: 1,
                    ioWeight: 2,
                },
                ...(options.signal ? {signal: options.signal} : {}),
            });
            const ppmPath = join(tempDirectory, `page-${page}.ppm`);
            const render = await convertDjvuPageToImage(djvuPath, ppmPath, page, `djvu-tiff-export-${randomUUID()}`, {
                format: 'ppm',
                ...(options.signal ? {signal: options.signal} : {}),
            }).finally(() => brokerLease.release());
            if (!render.success) throw new Error(render.error ?? `Failed to render DjVu page ${page}`);
            stagedBytes += render.fileSize;
            if (stagedBytes > DJVU_EXPORT_MAX_STAGED_BYTES) {
                throw new Error('DjVu TIFF export exceeds the staged-byte limit');
            }
            pagePaths.push(ppmPath);
            options.onProgress?.({
                phase: 'rendering',
                processed: index + 1,
                total: pages.length,
                percent: ((index + 1) / pages.length) * 90,
            });
        }
        options.onProgress?.({
            phase: 'combining',
            processed: 0,
            total: 1,
            percent: 90,
        });
        const targetPath = /\.tiff?$/iu.test(outputPath) ? outputPath : `${outputPath}.tiff`;
        const combineLease = await mainJobBroker.acquire({
            ownerId: options.cancelGroup ?? `djvu-tiff-export:${djvuPath}`,
            kind: 'djvu-tiff-combine',
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 128 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 3,
            },
            ...(options.signal ? {signal: options.signal} : {}),
        });
        const combined = await tryCombinePagesWithNativeTiffCombiner(
            pagePaths,
            targetPath,
            options.signal,
        ).finally(() => combineLease.release());
        if (!combined) throw new Error('Native TIFF output service is unavailable for DjVu export');
        options.onProgress?.({
            phase: 'combining',
            processed: 1,
            total: 1,
            percent: 100,
        });
        return [targetPath];
    });
}
