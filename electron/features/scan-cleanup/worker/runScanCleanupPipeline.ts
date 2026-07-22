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
import {
    getScanCleanupPageOverride,
    resolveScanCleanupPageLayout,
} from '@contracts/scanCleanupPageOverrides';
import type { TScanCleanupResolvedPageLayout } from '@contracts/scanCleanupPageOverrides';
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
    pdfPageOpsBinary?: string;
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

interface ICleanupPageMetadata {
    layoutClassification: ICleanupMetadata['layoutClassification'];
    cutterX: number | null;
    rotation: IScanCleanupOptions['pageOverrides'][string]['rotation'];
    excluded: boolean;
    blankOutputsSkipped: number;
    outputCount: number;
    outputs?: ILosslessAnalysisOutput[];
}

interface ILosslessAnalysisOutput {
    half: 'full' | 'left' | 'right';
    cropRect: IScanCleanupRect;
    inputWidth: number;
    inputHeight: number;
}

interface IScanCleanupRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface IPdfPageSize {
    pageNumber: number;
    xPoints?: number;
    yPoints?: number;
    widthPoints: number;
    heightPoints: number;
    rotation: number;
}

interface ICleanupOutputJob {
    outputPath: string;
    metadataPath: string;
}

interface ICleanupPageJob {
    inputPath: string;
    sourcePageIndex: number;
    pageMetadataPath: string;
    options: {
        dpi: number;
        layout: TScanCleanupResolvedPageLayout;
        cropContent: boolean;
        matchPageSize: boolean;
        pageAlignment: IScanCleanupOptions['pageAlignment'];
        marginsMm: number[];
        outputMode: IScanCleanupOptions['outputMode'];
        thickness: number;
        despeckle: boolean;
        rotation: IScanCleanupOptions['pageOverrides'][string]['rotation'];
        excluded: boolean;
        skipBlankPages: boolean;
        experimentalAutoDewarp: boolean;
        manualSplitX: number | null;
        manualContentBoxes: IScanCleanupOptions['pageOverrides'][string]['manualContentBoxes'];
        placementOverrides: IScanCleanupOptions['pageOverrides'][string]['placementOverrides'];
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

function pruneLosslessScanCleanupOptions(options: IScanCleanupOptions): IScanCleanupOptions {
    return {
        ...options,
        outputMode: 'color',
        thickness: 0,
        despeckle: false,
        skipBlankPages: false,
        straightenCurvedLines: false,
    };
}

function rectFromPoints(points: Array<{
    x: number;
    y: number
}>): IScanCleanupRect {
    const left = Math.min(...points.map(point => point.x));
    const right = Math.max(...points.map(point => point.x));
    const bottom = Math.min(...points.map(point => point.y));
    const top = Math.max(...points.map(point => point.y));
    return {
        x: left,
        y: bottom,
        width: right - left,
        height: top - bottom,
    };
}

function unrotateAnalysisPoint(
    point: {
        x: number;
        y: number
    },
    inputWidth: number,
    inputHeight: number,
    rotation: ICleanupPageMetadata['rotation'],
) {
    if (rotation === 90) {
        return {
            x: point.y,
            y: inputHeight - point.x,
        };
    }
    if (rotation === 180) {
        return {
            x: inputWidth - point.x,
            y: inputHeight - point.y,
        };
    }
    if (rotation === 270) {
        return {
            x: inputWidth - point.y,
            y: point.x,
        };
    }
    return point;
}

function displayPointToPdf(
    point: {
        x: number;
        y: number
    },
    inputWidth: number,
    inputHeight: number,
    page: IPdfPageSize,
) {
    const markerX = point.x / inputWidth;
    const markerY = point.y / inputHeight;
    const x = page.xPoints ?? 0;
    const y = page.yPoints ?? 0;
    const rotation = ((Math.round(page.rotation / 90) * 90 % 360) + 360) % 360;
    if (rotation === 90) {
        return {
            x: x + markerY * page.widthPoints,
            y: y + markerX * page.heightPoints,
        };
    }
    if (rotation === 180) {
        return {
            x: x + (1 - markerX) * page.widthPoints,
            y: y + markerY * page.heightPoints,
        };
    }
    if (rotation === 270) {
        return {
            x: x + (1 - markerY) * page.widthPoints,
            y: y + (1 - markerX) * page.heightPoints,
        };
    }
    return {
        x: x + markerX * page.widthPoints,
        y: y + (1 - markerY) * page.heightPoints,
    };
}

function mapLosslessAnalysisRectToPdf(
    rect: IScanCleanupRect,
    inputWidth: number,
    inputHeight: number,
    cleanupRotation: ICleanupPageMetadata['rotation'],
    page: IPdfPageSize,
) {
    const corners = [
        {
            x: rect.x,
            y: rect.y,
        },
        {
            x: rect.x + rect.width,
            y: rect.y,
        },
        {
            x: rect.x,
            y: rect.y + rect.height,
        },
        {
            x: rect.x + rect.width,
            y: rect.y + rect.height,
        },
    ].map(point => unrotateAnalysisPoint(point, inputWidth, inputHeight, cleanupRotation))
        .map(point => displayPointToPdf(point, inputWidth, inputHeight, page));
    return rectFromPoints(corners);
}

function placeUniformBox(
    content: IScanCleanupRect,
    width: number,
    height: number,
    alignment: IScanCleanupOptions['pageAlignment'],
) {
    const [
        vertical,
        horizontal = vertical,
    ] = alignment.split('-');
    const x = horizontal === 'left'
        ? content.x
        : horizontal === 'right' ? content.x + content.width - width : content.x + (content.width - width) / 2;
    const y = vertical === 'bottom'
        ? content.y
        : vertical === 'top' ? content.y + content.height - height : content.y + (content.height - height) / 2;
    return {
        x,
        y,
        width,
        height,
    };
}

async function runLosslessScanCleanup(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    preparedPdfPath: string,
    preparedWarnings: string[],
    pageNumbers: number[],
    dpiDetails: Awaited<ReturnType<typeof detectSourceDpiDetails>>,
    scratch: string,
    stagedPdfPath: string,
    signal: AbortSignal,
    onProgress: (progress: IScanCleanupProgress) => void,
    log: TWorkerLog,
    dependencies: IRunScanCleanupPipelineDependencies,
) {
    if (!paths.pdfPageOpsBinary) throw new Error('evb-pdf-page-ops is unavailable for lossless scan cleanup');
    const pageSizesPath = join(scratch, 'page-sizes.json');
    await dependencies.runCommand(paths.pdfPageOpsBinary, [
        'page-sizes',
        '--input',
        preparedPdfPath,
        '--output',
        pageSizesPath,
    ], {
        signal,
        commandLabel: 'evb-pdf-page-ops(page-sizes:scan-cleanup)',
        timeoutMs: 60_000,
        log,
    });
    const pageSizes = (JSON.parse(await readFile(pageSizesPath, 'utf8')) as {pages: IPdfPageSize[]}).pages;
    const documentDpi = clampDpi(dpiDetails.documentDpi);
    const losslessOptions = pruneLosslessScanCleanupOptions(request.options);
    let rasterizedCount = 0;
    const pages = await mapScanCleanupRasterPages(pageNumbers, 3, async pageNumber => {
        signal.throwIfAborted();
        const dpi = clampDpi(dpiDetails.pageDpiByNumber.get(pageNumber) ?? documentDpi);
        const inputPath = join(scratch, `analysis-${pageNumber}.png`);
        await dependencies.renderPage(paths, log, pageNumber, preparedPdfPath, inputPath, dpi, undefined, signal);
        const pageOverride = getScanCleanupPageOverride(losslessOptions.pageOverrides, pageNumber);
        rasterizedCount += 1;
        emitProgress(onProgress, 'rasterizing', rasterizedCount, pageNumbers.length, 5 + (35 * rasterizedCount / pageNumbers.length));
        return {
            inputPath,
            sourcePageIndex: pageNumber - 1,
            pageMetadataPath: join(scratch, `analysis-${pageNumber}.json`),
            options: {
                dpi,
                layout: resolveScanCleanupPageLayout(losslessOptions.layoutMode, pageOverride.layoutOverride),
                cropContent: losslessOptions.crop,
                marginsMm: [
                    losslessOptions.marginsMm,
                    losslessOptions.marginsMm,
                    losslessOptions.marginsMm,
                    losslessOptions.marginsMm,
                ],
                outputMode: losslessOptions.outputMode,
                thickness: losslessOptions.thickness,
                despeckle: losslessOptions.despeckle,
                rotation: pageOverride.rotation,
                excluded: pageOverride.excluded,
                skipBlankPages: false,
                experimentalAutoDewarp: false,
                manualSplitX: pageOverride.manualSplitX,
                manualContentBoxes: pageOverride.manualContentBoxes,
            },
        };
    });
    const manifestPath = join(scratch, 'lossless-analysis-manifest.json');
    await writeFile(manifestPath, JSON.stringify({
        classifyOnly: true,
        sharedOptions: {},
        pages,
    }));
    await dependencies.runSidecar(paths.scanCleanupBinary, manifestPath, signal, log, progress => {
        emitProgress(onProgress, 'cleaning', progress.page, pageNumbers.length, 40 + (30 * progress.page / pageNumbers.length));
    });

    const summary: IScanCleanupSummary = {
        inputPages: pageNumbers.length,
        outputPages: 0,
        spreadsSplit: 0,
        offcutsDiscarded: 0,
        deskewSkipped: 0,
        cropSkipped: 0,
        excludedPages: 0,
        blankPagesSkipped: 0,
        warnings: [...preparedWarnings],
    };
    const analyzedPages: Array<{
        sourcePageIndex: number;
        rotationQuarterTurns: number;
        outputs: Array<{
            half: ILosslessAnalysisOutput['half'];
            cropRect: IScanCleanupRect
        }>;
        pageOverride: ReturnType<typeof getScanCleanupPageOverride>;
    }> = [];
    for (const [
        index,
        page,
    ] of pages.entries()) {
        const metadata = JSON.parse(await readFile(page.pageMetadataPath, 'utf8')) as ICleanupPageMetadata;
        const pageOverride = getScanCleanupPageOverride(losslessOptions.pageOverrides, index + 1);
        if (metadata.excluded) {
            summary.excludedPages += 1;
            continue;
        }
        if (metadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
        if (metadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
        const pageSize = pageSizes[index];
        if (!pageSize) throw new Error(`evb-pdf-page-ops returned no geometry for page ${String(index + 1)}`);
        const outputs = (metadata.outputs ?? []).map(output => ({
            half: output.half,
            cropRect: mapLosslessAnalysisRectToPdf(
                output.cropRect,
                output.inputWidth,
                output.inputHeight,
                metadata.rotation,
                pageSize,
            ),
        }));
        if (losslessOptions.readingOrder === 'rtl' && metadata.layoutClassification === 'two-page-spread') outputs.reverse();
        analyzedPages.push({
            sourcePageIndex: index,
            rotationQuarterTurns: pageOverride.rotation / 90,
            outputs,
            pageOverride,
        });
    }
    const allOutputs = analyzedPages.flatMap(page => page.outputs);
    if (allOutputs.length === 0) throw new Error('evb-scan-cleanup analysis produced no output pages');
    if (losslessOptions.matchPageSize) {
        const width = Math.max(...allOutputs.map(output => output.cropRect.width));
        const height = Math.max(...allOutputs.map(output => output.cropRect.height));
        for (const page of analyzedPages) {
            for (const output of page.outputs) {
                const alignment = page.pageOverride.placementOverrides?.[output.half] ?? losslessOptions.pageAlignment;
                output.cropRect = placeUniformBox(output.cropRect, width, height, alignment);
            }
        }
    }
    summary.outputPages = allOutputs.length;
    const instructionsPath = join(scratch, 'split-pages.json');
    await writeFile(instructionsPath, JSON.stringify({pages: analyzedPages.map(page => ({
        sourcePageIndex: page.sourcePageIndex,
        rotationQuarterTurns: page.rotationQuarterTurns,
        outputs: page.outputs.map(output => ({cropRect: output.cropRect})),
    }))}));
    emitProgress(onProgress, 'assembling', pageNumbers.length, pageNumbers.length, 82);
    await dependencies.runCommand(paths.pdfPageOpsBinary, [
        'split-pages',
        '--input',
        preparedPdfPath,
        '--output',
        stagedPdfPath,
        '--instructions-file',
        instructionsPath,
    ], {
        signal,
        commandLabel: 'evb-pdf-page-ops(split-pages:scan-cleanup)',
        timeoutMs: 10 * 60 * 1000,
        log,
    });
    return summary;
}

export async function mapScanCleanupRasterPages<T, R>(
    values: readonly T[],
    concurrency: number,
    task: (value: T, index: number) => Promise<R>,
) {
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    const workers = Array.from({length: Math.min(Math.max(1, concurrency), values.length)}, async () => {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await task(values[index]!, index);
        }
    });
    await Promise.all(workers);
    return results;
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
        if (request.options.preserveOriginalQuality) {
            const summary = await runLosslessScanCleanup(
                request,
                paths,
                prepared.pdfPath,
                prepared.warnings,
                pageNumbers,
                dpiDetails,
                scratch,
                stagedPdfPath,
                signal,
                onProgress,
                log,
                dependencies,
            );
            if ((await stat(stagedPdfPath)).size <= 0) throw new Error('Lossless PDF assembler produced an empty file');
            emitProgress(onProgress, 'handoff', pageCount, pageCount, 98);
            await copyFile(stagedPdfPath, publishTempPath);
            signal.throwIfAborted();
            await rename(publishTempPath, request.outputPdfPath);
            emitProgress(onProgress, 'handoff', pageCount, pageCount, 100);
            return summary;
        }
        const pageDpi = new Map<number, number>();
        let rasterizedCount = 0;
        const pages = await mapScanCleanupRasterPages(pageNumbers, 3, async pageNumber => {
            if (signal.aborted) throw signal.reason;
            const dpi = clampDpi(dpiDetails.pageDpiByNumber.get(pageNumber) ?? documentDpi);
            pageDpi.set(pageNumber, dpi);
            const inputPath = join(scratch, `source-${pageNumber}.png`);
            await dependencies.renderPage(paths, log, pageNumber, prepared.pdfPath, inputPath, dpi, undefined, signal);
            const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, pageNumber);
            const pageOptions = {
                dpi,
                layout: resolveScanCleanupPageLayout(request.options.layoutMode, pageOverride.layoutOverride),
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
                rotation: pageOverride.rotation,
                excluded: pageOverride.excluded,
                skipBlankPages: request.options.skipBlankPages,
                experimentalAutoDewarp: request.options.straightenCurvedLines,
                manualSplitX: pageOverride.manualSplitX,
                manualContentBoxes: pageOverride.manualContentBoxes,
                placementOverrides: pageOverride.placementOverrides,
            };
            const page: ICleanupPageJob = {
                inputPath,
                sourcePageIndex: pageNumber - 1,
                pageMetadataPath: join(scratch, `clean-${pageNumber}-page.json`),
                options: pageOptions,
                outputs: [
                    0,
                    1,
                ].map(outputIndex => ({
                    outputPath: join(scratch, `clean-${pageNumber}-${outputIndex}.png`),
                    metadataPath: join(scratch, `clean-${pageNumber}-${outputIndex}.json`),
                })),
            };
            rasterizedCount += 1;
            emitProgress(onProgress, 'rasterizing', rasterizedCount, pageCount, 5 + (25 * rasterizedCount / pageCount));
            return page;
        });
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
            excludedPages: 0,
            blankPagesSkipped: 0,
            warnings: [...prepared.warnings],
        };
        for (const [
            pageIndex,
            page,
        ] of pages.entries()) {
            const {outputs} = page;
            const pageMetadata = JSON.parse(await readFile(page.pageMetadataPath, 'utf8')) as ICleanupPageMetadata;
            if (pageMetadata.excluded) {
                summary.excludedPages += 1;
                continue;
            }
            summary.blankPagesSkipped += pageMetadata.blankOutputsSkipped;
            const pageOutputPages: typeof outputPages = [];
            for (const output of outputs) {
                try {
                    const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8')) as ICleanupMetadata;
                    await stat(output.outputPath);
                    pageOutputPages.push({
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
            if (request.options.readingOrder === 'rtl' && pageMetadata.layoutClassification === 'two-page-spread') {
                pageOutputPages.reverse();
            }
            outputPages.push(...pageOutputPages);
            if (pageMetadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
            if (pageMetadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
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
