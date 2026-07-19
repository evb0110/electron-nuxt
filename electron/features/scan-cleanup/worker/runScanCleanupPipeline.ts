import {
    copyFile,
    mkdtemp,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import {
    dirname,
    join,
} from 'path';
import type {
    IScanCleanupOptions,
    IScanCleanupProgress,
    IScanCleanupSummary,
} from '@contracts/electronApiScanCleanup';
import { getPdfPageCount } from '@electron/pdf/pdfPageCount';
import { detectSourceDpiDetails } from '@electron/pdf/sourceDpiDetection';
import {
    preparePdfForPoppler,
    renderPdfPageToPng,
} from '@electron/ocr/worker/popplerStage';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import { runScanCleanupSidecar } from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';

export interface IScanCleanupWorkerPaths {
    qpdfBinary: string;
    pdftoppmBinary: string;
    pdfimagesBinary?: string;
    scanCleanupBinary: string;
    pdfImageCombineBinary: string;
    tempDir: string;
}

export interface IRunScanCleanupPipelineRequest {
    sourcePdfPath: string;
    outputPdfPath: string;
    options: IScanCleanupOptions;
}

interface ICleanupMetadata {
    outputWidth: number;
    outputHeight: number;
    layoutClassification: 'single-uncut-page' | 'page-with-offcut' | 'two-page-spread';
    skewApplied: boolean;
    contentBox?: unknown;
    warnings?: string[];
}

interface ICleanupOutputJob {
    outputPath: string;
    metadataPath: string;
}

interface ICleanupPageJob {
    inputPath: string;
    sourcePageIndex: number;
    options: {
        dpi: number;
        layout: IScanCleanupOptions['layoutMode'];
        cropContent: boolean;
        matchPageSize: boolean;
        pageAlignment: IScanCleanupOptions['pageAlignment'];
        marginsMm: number[];
        outputMode: IScanCleanupOptions['outputMode'];
        thickness: number;
        despeckle: boolean;
    };
    outputs: ICleanupOutputJob[];
}

export interface IRunScanCleanupPipelineDependencies {
    getPageCount: typeof getPdfPageCount;
    detectSourceDpi: typeof detectSourceDpiDetails;
    preparePdf: typeof preparePdfForPoppler;
    renderPage: typeof renderPdfPageToPng;
    runSidecar: typeof runScanCleanupSidecar;
    runCommand: typeof runNativeToolCommand;
}

const defaultDependencies: IRunScanCleanupPipelineDependencies = {
    getPageCount: getPdfPageCount,
    detectSourceDpi: detectSourceDpiDetails,
    preparePdf: preparePdfForPoppler,
    renderPage: renderPdfPageToPng,
    runSidecar: runScanCleanupSidecar,
    runCommand: runNativeToolCommand,
};

function clampDpi(value: number | null | undefined) {
    return Math.min(600, Math.max(150, Math.round(value ?? 300)));
}

function emitProgress(
    callback: (progress: IScanCleanupProgress) => void,
    phase: IScanCleanupProgress['phase'],
    processedCount: number,
    totalPages: number,
    percent: number,
) {
    callback({
        phase,
        processedCount,
        totalPages,
        percent: Math.min(100, Math.max(0, percent)),
    });
}

export async function runScanCleanupPipeline(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    signal: AbortSignal,
    onProgress: (progress: IScanCleanupProgress) => void,
    log: TWorkerLog = () => undefined,
    dependencies: IRunScanCleanupPipelineDependencies = defaultDependencies,
): Promise<IScanCleanupSummary> {
    const scratch = await mkdtemp(join(paths.tempDir, 'scan-cleanup-'));
    const sessionId = randomUUID();
    const stagedPdfPath = join(scratch, 'cleaned.pdf');
    const publishTempPath = join(dirname(request.outputPdfPath), `.${sessionId}.scan-cleanup.tmp`);
    const tracked = new Set<string>();
    const track = (path: string) => {
        tracked.add(path);
        return path;
    };
    try {
        emitProgress(onProgress, 'normalizing', 0, 1, 2);
        const prepared = await dependencies.preparePdf(
            paths,
            log,
            request.sourcePdfPath,
            sessionId,
            track,
            signal,
        );
        const pageCount = await dependencies.getPageCount(prepared.pdfPath, {signal});
        const pageNumbers = Array.from({length: pageCount}, (_, index) => index + 1);
        const dpiDetails = await dependencies.detectSourceDpi(
            prepared.pdfPath,
            paths.pdfimagesBinary,
            log,
            undefined,
            signal,
            pageNumbers,
        );
        const documentDpi = clampDpi(dpiDetails.documentDpi);
        const pages: ICleanupPageJob[] = [];
        const pageDpi = new Map<number, number>();
        for (const pageNumber of pageNumbers) {
            const dpi = clampDpi(dpiDetails.pageDpiByNumber.get(pageNumber) ?? documentDpi);
            pageDpi.set(pageNumber, dpi);
            const inputPath = join(scratch, `source-${pageNumber}.png`);
            await dependencies.renderPage(paths, log, pageNumber, prepared.pdfPath, inputPath, dpi, undefined, signal);
            const pageOptions = {
                dpi,
                layout: request.options.layoutMode,
                cropContent: request.options.crop,
                matchPageSize: request.options.matchPageSize,
                pageAlignment: request.options.pageAlignment,
                marginsMm: [
                    request.options.marginsMm,
                    request.options.marginsMm,
                    request.options.marginsMm,
                    request.options.marginsMm,
                ],
                outputMode: request.options.outputMode,
                thickness: request.options.thickness,
                despeckle: request.options.outputMode === 'bw' && request.options.despeckle,
            };
            pages.push({
                inputPath,
                sourcePageIndex: pageNumber - 1,
                options: pageOptions,
                outputs: [
                    0,
                    1,
                ].map(outputIndex => ({
                    outputPath: join(scratch, `clean-${pageNumber}-${outputIndex}.png`),
                    metadataPath: join(scratch, `clean-${pageNumber}-${outputIndex}.json`),
                })),
            });
            emitProgress(onProgress, 'rasterizing', pageNumber, pageCount, 5 + (25 * pageNumber / pageCount));
        }
        const manifestPath = join(scratch, 'cleanup-manifest.json');
        await writeFile(manifestPath, JSON.stringify({
            sharedOptions: {},
            pages,
        }));
        await dependencies.runSidecar(paths.scanCleanupBinary, manifestPath, signal, log, progress => {
            emitProgress(onProgress, 'cleaning', progress.page, pageCount, 30 + (45 * progress.page / pageCount));
        });
        const outputPages: Array<{
            path: string;
            dpi: number;
            metadata: ICleanupMetadata
        }> = [];
        const summary: IScanCleanupSummary = {
            inputPages: pageCount,
            outputPages: 0,
            spreadsSplit: 0,
            offcutsDiscarded: 0,
            deskewSkipped: 0,
            cropSkipped: 0,
            warnings: [...prepared.warnings],
        };
        for (const [
            pageIndex,
            page,
        ] of pages.entries()) {
            const {outputs} = page;
            let pageClassification: ICleanupMetadata['layoutClassification'] | null = null;
            for (const output of outputs) {
                try {
                    const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8')) as ICleanupMetadata;
                    await stat(output.outputPath);
                    pageClassification = metadata.layoutClassification;
                    outputPages.push({
                        path: output.outputPath,
                        dpi: request.options.matchPageSize
                            ? documentDpi
                            : pageDpi.get(pageIndex + 1) ?? documentDpi,
                        metadata,
                    });
                    if (!metadata.skewApplied) summary.deskewSkipped += 1;
                    if (request.options.crop && metadata.contentBox == null) summary.cropSkipped += 1;
                    summary.warnings.push(...(metadata.warnings ?? []).map(warning => `Page ${pageIndex + 1}: ${warning}`));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            }
            if (pageClassification === 'two-page-spread') summary.spreadsSplit += 1;
            if (pageClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
        }
        summary.outputPages = outputPages.length;
        if (outputPages.length === 0) throw new Error('evb-scan-cleanup produced no output pages');
        const combineManifestPath = join(scratch, 'combine-manifest.tsv');
        await writeFile(combineManifestPath, outputPages.map(output => [
            'image',
            (output.metadata.outputWidth / output.dpi * 72).toFixed(6),
            (output.metadata.outputHeight / output.dpi * 72).toFixed(6),
            output.path,
        ].join('\t')).join('\n') + '\n');
        emitProgress(onProgress, 'assembling', pageCount, pageCount, 82);
        await dependencies.runCommand(paths.pdfImageCombineBinary, [
            '--output',
            stagedPdfPath,
            '--compact-manifest',
            combineManifestPath,
            '--json-progress',
        ], {
            signal,
            commandLabel: 'evb-pdf-image-combine(scan-cleanup)',
            timeoutMs: 10 * 60 * 1000,
            log,
        });
        if ((await stat(stagedPdfPath)).size <= 0) throw new Error('PDF assembler produced an empty file');
        emitProgress(onProgress, 'handoff', pageCount, pageCount, 98);
        await copyFile(stagedPdfPath, publishTempPath);
        if (signal.aborted) throw signal.reason;
        await rename(publishTempPath, request.outputPdfPath);
        emitProgress(onProgress, 'handoff', pageCount, pageCount, 100);
        return summary;
    } finally {
        await rm(publishTempPath, {force: true}).catch(() => undefined);
        await Promise.all(Array.from(tracked, path => rm(path, {force: true}).catch(() => undefined)));
        await rm(scratch, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}
