import { randomUUID } from 'node:crypto';
import {
    copyFile,
    mkdir,
    mkdtemp,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    basename,
    dirname,
    extname,
    join,
} from 'node:path';
import type { IImageExportProgress } from '@contracts/electronApiDocuments';
import { getDjvuPageCount } from '@electron/djvu/metadata';
import {convertDjvuPageToImage} from '@electron/features/djvu/public';
import { convertRenderedPpmToPng } from '@electron/features/image-export/main/export';
import { tryCombinePagesWithNativeTiffCombiner } from '@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { mainJobBroker } from '@electron/resources/jobBroker';

interface IDjvuImageExportOptions {
    pageNumbers?: number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    onProgress?: (progress: Pick<IImageExportProgress, 'phase' | 'processed' | 'total' | 'percent'>) => void;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortErrorFromSignal(signal);
}

async function resolvePages(path: string, requested: number[] | undefined, signal?: AbortSignal) {
    const pageCount = await getDjvuPageCount(path, {...(signal ? {signal} : {})});
    const pages = requested ?? Array.from({length: pageCount}, (_, index) => index + 1);
    if (pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
        throw new Error(`DjVu export page numbers must be between 1 and ${pageCount}`);
    }
    return pages;
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
    const tempDirectory = await mkdtemp(join(tmpdir(), 'djvu-image-export-'));
    const staged: Array<{
        tempPath: string;
        outputPath: string
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
                return convertRenderedPpmToPng(ppmPath, options.signal, options.cancelGroup);
            })().finally(() => brokerLease.release());
            const outputPath = outputPaths[index];
            if (!outputPath) throw new Error('DjVu image export target is missing');
            staged.push({
                tempPath: pngPath,
                outputPath,
            });
            options.onProgress?.({
                phase: 'rendering',
                processed: index + 1,
                total: pages.length,
                percent: ((index + 1) / pages.length) * 100,
            });
        }
        for (const file of staged) {
            await mkdir(dirname(file.outputPath), {recursive: true});
            const sibling = makeSiblingTempPath(file.outputPath);
            await copyFile(file.tempPath, sibling);
            await atomicReplace(sibling, file.outputPath);
        }
        return outputPaths;
    } finally {
        await rm(tempDirectory, {
            force: true,
            recursive: true,
        });
    }
}

export async function exportDjvuPagesAsPng(
    djvuPath: string,
    outputTemplatePath: string,
    options: IDjvuImageExportOptions = {},
) {
    const pages = await resolvePages(djvuPath, options.pageNumbers, options.signal);
    return renderDjvuPngPages(djvuPath, buildPngOutputPaths(outputTemplatePath, pages), pages, options);
}

export async function exportDjvuAsMultiPageTiff(
    djvuPath: string,
    outputPath: string,
    options: IDjvuImageExportOptions = {},
) {
    const pages = await resolvePages(djvuPath, options.pageNumbers, options.signal);
    const tempDirectory = await mkdtemp(join(tmpdir(), 'djvu-tiff-export-'));
    try {
        const pagePaths: string[] = [];
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
    } finally {
        await rm(tempDirectory, {
            force: true,
            recursive: true,
        });
    }
}
