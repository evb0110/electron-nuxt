import {
    access,
    copyFile,
    mkdtemp,
    open,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {constants as fsConstants} from 'fs';
import { randomUUID } from 'crypto';
import {
    dirname,
    join,
} from 'path';
import type {
    INativeScanCleanupBinarizationDiagnosticsV3,
    IScanCleanupOptions,
    IScanCleanupPixelRect,
    IScanCleanupProgress,
    IScanCleanupSplitSeamPolyline,
    IScanCleanupSummary,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import { getPdfPageCount } from '@electron/pdf/pdfPageCount';
import { detectSourceDpiDetails } from '@electron/pdf/sourceDpiDetection';
import {
    preparePdfForPoppler,
    renderPdfPageToPng,
} from '@electron/ocr/worker/popplerStage';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import { runScanCleanupSidecar } from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {buildNativeScanCleanupManifest} from '@electron/features/scan-cleanup/policy/buildNativeScanCleanupManifest';
import {resolveScanCleanupPipelineMaxPixels} from '@electron/features/scan-cleanup/policy/effectiveOptions';

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
    sourcePageNumbers?: number[];
    outputModeRecommendations?: Partial<Record<string, TScanCleanupOutputMode>>;
}

interface ICleanupMetadata {
    outputWidthPx: number;
    outputHeightPx: number;
    canvasWidthPx: number;
    canvasHeightPx: number;
    layoutClassification: 'single-uncut-page' | 'page-with-offcut' | 'two-page-spread';
    splitSeam?: IScanCleanupSplitSeamPolyline;
    splitAbstained?: boolean;
    detectedSkewDegrees?: number;
    skewConfidence?: number;
    skewApplied: boolean;
    manualSkew?: boolean;
    bilevelWritten?: boolean;
    layeredWritten?: boolean;
    layeredBackgroundDpi?: number;
    illuminationNormalized?: boolean;
    binarizationMode?: IScanCleanupOptions['binarization'] | null;
    binarizationDiagnostics?: INativeScanCleanupBinarizationDiagnosticsV3 | null;
    despeckleFallback?: boolean;
    dewarpConfidence?: number | null;
    contentBox?: unknown;
    warnings?: string[];
    renderDpi?: number;
    matchedCanvasTargetWidthPoints?: number | null;
    matchedCanvasTargetHeightPoints?: number | null;
}

interface ICleanupPageMetadata {
    layoutClassification: ICleanupMetadata['layoutClassification'];
    layoutConfidence?: number;
    cutterXPx: number | null;
    splitSeam?: IScanCleanupSplitSeamPolyline;
    splitAbstained?: boolean;
    rotationDegrees: IScanCleanupOptions['pageOverrides'][string]['rotationDegrees'];
    canvasScope: 'page' | 'document';
    excluded: boolean;
    blankOutputsSkipped: number;
    outputCount: number;
    outputs?: ILosslessAnalysisOutput[];
    recommendedOutputMode?: TScanCleanupOutputMode;
}

interface ILosslessAnalysisOutput {
    half: 'full' | 'left' | 'right';
    cropRect: IScanCleanupPixelRect;
    inputWidthPx: number;
    inputHeightPx: number;
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

const SCAN_CLEANUP_MAX_DIMENSION_PX = 40_000;
const MODE_ANALYSIS_DPI = 150;
const SIZE_PROBE_DPI = 72;
// Rome p1/p7/p49 at source DPI retained scan texture, fine text, and mixed
// illustration edges at these settings. Color gets two extra quality points
// for chroma detail; grayscale and mixed pages do not spend bytes on it.
const SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY = 85;
const SCAN_CLEANUP_COLOR_JPEG_QUALITY = 87;

function resolveTonalJpegQuality(mode: TScanCleanupOutputMode) {
    if (mode === 'color') {
        return SCAN_CLEANUP_COLOR_JPEG_QUALITY;
    }
    if (mode === 'grayscale' || mode === 'mixed') {
        return SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY;
    }
    return undefined;
}

function resolveSourceDpi(value: number | null | undefined, fallback = 300) {
    const candidate = value ?? fallback;
    return Number.isFinite(candidate) && candidate > 0
        ? Math.max(1, Math.round(candidate))
        : fallback;
}

async function readPngDimensions(path: string) {
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(24);
        const {bytesRead} = await handle.read(header, 0, header.byteLength, 0);
        if (
            bytesRead !== header.byteLength
            || header.subarray(0, 8).compare(Buffer.from([
                0x89,
                0x50,
                0x4e,
                0x47,
                0x0d,
                0x0a,
                0x1a,
                0x0a,
            ])) !== 0
        ) {
            throw new Error(`Unable to inspect raster dimensions for ${path}`);
        }
        return {
            width: header.readUInt32BE(16),
            height: header.readUInt32BE(20),
        };
    } finally {
        await handle.close();
    }
}

function resolveSafeRenderDpi(
    requestedRenderDpi: number,
    maxPixels: number,
    probe: {
        dpi: number;
        width: number;
        height: number
    },
) {
    const maxDimensionDpi = probe.dpi * Math.min(
        SCAN_CLEANUP_MAX_DIMENSION_PX / probe.width,
        SCAN_CLEANUP_MAX_DIMENSION_PX / probe.height,
    );
    const maxPixelDpi = probe.dpi * Math.sqrt(
        maxPixels / (probe.width * probe.height),
    );
    return Math.max(1, Math.floor(Math.min(
        requestedRenderDpi,
        maxDimensionDpi,
        maxPixelDpi,
    )));
}

function emitProgress(
    callback: (progress: IScanCleanupProgress) => void,
    stage: IScanCleanupProgress['stage'],
    completedUnits: number,
    totalUnits: number,
    percent: number,
    completedPageNumbers?: Iterable<number>,
) {
    callback({
        stage,
        completedUnits,
        totalUnits,
        percent: Math.min(100, Math.max(0, percent)),
        ...(completedPageNumbers ? {completedPageNumbers: [...completedPageNumbers]} : {}),
    });
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
    inputWidthPx: number,
    inputHeightPx: number,
    rotationDegrees: ICleanupPageMetadata['rotationDegrees'],
) {
    if (rotationDegrees === 90) {
        return {
            x: point.y,
            y: inputHeightPx - point.x,
        };
    }
    if (rotationDegrees === 180) {
        return {
            x: inputWidthPx - point.x,
            y: inputHeightPx - point.y,
        };
    }
    if (rotationDegrees === 270) {
        return {
            x: inputWidthPx - point.y,
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
    inputWidthPx: number,
    inputHeightPx: number,
    page: IPdfPageSize,
) {
    const markerX = point.x / inputWidthPx;
    const markerY = point.y / inputHeightPx;
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
    rect: IScanCleanupPixelRect,
    inputWidthPx: number,
    inputHeightPx: number,
    cleanupRotation: ICleanupPageMetadata['rotationDegrees'],
    page: IPdfPageSize,
) {
    const corners = [
        {
            x: rect.xPx,
            y: rect.yPx,
        },
        {
            x: rect.xPx + rect.widthPx,
            y: rect.yPx,
        },
        {
            x: rect.xPx,
            y: rect.yPx + rect.heightPx,
        },
        {
            x: rect.xPx + rect.widthPx,
            y: rect.yPx + rect.heightPx,
        },
    ].map(point => unrotateAnalysisPoint(point, inputWidthPx, inputHeightPx, cleanupRotation))
        .map(point => displayPointToPdf(point, inputWidthPx, inputHeightPx, page));
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
    const documentDpi = resolveSourceDpi(dpiDetails.documentDpi);
    let rasterizedCount = 0;
    const rasterizedPageNumbers = new Set<number>();
    const pageInputs = await mapScanCleanupRasterPages(pageNumbers, 3, async pageNumber => {
        signal.throwIfAborted();
        const dpi = resolveSourceDpi(dpiDetails.pageDpiByNumber.get(pageNumber), documentDpi);
        const inputPath = join(scratch, `analysis-${pageNumber}.png`);
        await dependencies.renderPage(paths, log, pageNumber, preparedPdfPath, inputPath, dpi, undefined, signal);
        rasterizedCount += 1;
        rasterizedPageNumbers.add(pageNumber);
        emitProgress(onProgress, 'rasterizing', rasterizedCount, pageNumbers.length, 5 + (35 * rasterizedCount / pageNumbers.length), rasterizedPageNumbers);
        return {
            inputPath,
            pageNumber,
            dpi,
            pageMetadataPath: join(scratch, `analysis-${pageNumber}.json`),
        };
    });
    const manifest = buildNativeScanCleanupManifest({
        operation: 'analyze',
        renderMode: 'final',
        canvasScope: 'document',
        qualityPath: 'lossless',
        options: request.options,
        experimental: {
            autoDewarp: request.options.autoDewarp ?? false,
            ...(request.options.autoDewarpDepth === undefined
                ? {}
                : {autoDewarpDepth: request.options.autoDewarpDepth}),
        },
        pages: pageInputs,
    });
    const pages = manifest.pages;
    const manifestPath = join(scratch, 'lossless-analysis-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    emitProgress(onProgress, 'classifying', 0, pageNumbers.length, 40, []);
    const classifiedPageNumbers = new Set<number>();
    await dependencies.runSidecar(paths.scanCleanupBinary, manifestPath, signal, log, (_progress, nativeProgress) => {
        if (nativeProgress.pageNumber !== undefined) {
            classifiedPageNumbers.add(pageNumbers[nativeProgress.pageNumber - 1]!);
        }
        const completedUnits = classifiedPageNumbers.size;
        emitProgress(
            onProgress,
            'classifying',
            completedUnits,
            pageNumbers.length,
            40 + (30 * completedUnits / pageNumbers.length),
            classifiedPageNumbers,
        );
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
        const sourcePageNumber = pageNumbers[index]!;
        const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, sourcePageNumber);
        if (metadata.excluded) {
            summary.excludedPages += 1;
            continue;
        }
        if (metadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
        if (metadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
        const pageSize = pageSizes[sourcePageNumber - 1];
        if (!pageSize) throw new Error(`evb-pdf-page-ops returned no geometry for page ${String(sourcePageNumber)}`);
        const outputs = (metadata.outputs ?? []).map(output => ({
            half: output.half,
            cropRect: mapLosslessAnalysisRectToPdf(
                output.cropRect,
                output.inputWidthPx,
                output.inputHeightPx,
                metadata.rotationDegrees,
                pageSize,
            ),
        }));
        if (request.options.readingOrder === 'rtl' && metadata.layoutClassification === 'two-page-spread') outputs.reverse();
        analyzedPages.push({
            sourcePageIndex: sourcePageNumber - 1,
            rotationQuarterTurns: pageOverride.rotationDegrees / 90,
            outputs,
            pageOverride,
        });
    }
    const allOutputs = analyzedPages.flatMap(page => page.outputs);
    if (allOutputs.length === 0) throw new Error('evb-scan-cleanup analysis produced no output pages');
    if (request.options.matchPageSize) {
        const width = Math.max(...allOutputs.map(output => output.cropRect.width));
        const height = Math.max(...allOutputs.map(output => output.cropRect.height));
        for (const page of analyzedPages) {
            for (const output of page.outputs) {
                const alignment = page.pageOverride.placementOverrides?.[output.half] ?? request.options.pageAlignment;
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
    emitProgress(onProgress, 'assembling', pageNumbers.length, pageNumbers.length, 82, pageNumbers);
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
        emitProgress(onProgress, 'normalizing', 0, 0, 2, []);
        const prepared = await dependencies.preparePdf(
            paths,
            log,
            request.sourcePdfPath,
            sessionId,
            track,
            signal,
        );
        const documentPageCount = await dependencies.getPageCount(prepared.pdfPath, {signal});
        const pageNumbers = request.sourcePageNumbers === undefined
            ? Array.from({length: documentPageCount}, (_, index) => index + 1)
            : [...request.sourcePageNumbers];
        if (
            pageNumbers.length === 0
            || pageNumbers.some(pageNumber => pageNumber > documentPageCount)
        ) {
            throw new Error('Scan cleanup source page scope is outside the document');
        }
        const pageCount = pageNumbers.length;
        emitProgress(onProgress, 'probing', 0, pageCount, 3, []);
        const dpiDetails = await dependencies.detectSourceDpi(
            prepared.pdfPath,
            paths.pdfimagesBinary,
            log,
            undefined,
            signal,
            pageNumbers,
            (completedPages, totalPages) => emitProgress(
                onProgress,
                'probing',
                completedPages,
                totalPages,
                3 + (2 * completedPages / Math.max(1, totalPages)),
            ),
        );
        const documentDpi = resolveSourceDpi(dpiDetails.documentDpi);
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
            emitProgress(onProgress, 'handoff', pageCount, pageCount, 98, pageNumbers);
            await copyFile(stagedPdfPath, publishTempPath);
            signal.throwIfAborted();
            await rename(publishTempPath, request.outputPdfPath);
            emitProgress(onProgress, 'handoff', pageCount, pageCount, 100, pageNumbers);
            return summary;
        }
        const sourceDpiByPage = new Map(pageNumbers.map(pageNumber => [
            pageNumber,
            resolveSourceDpi(dpiDetails.pageDpiByNumber.get(pageNumber), documentDpi),
        ]));
        const resolvedOutputModeByPage = new Map<number, TScanCleanupOutputMode>();
        const unresolvedAutoPages: number[] = [];
        for (const pageNumber of pageNumbers) {
            const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, pageNumber);
            if (pageOverride.excluded) {
                resolvedOutputModeByPage.set(pageNumber, 'color');
                continue;
            }
            const configuredMode = pageOverride.outputModeOverride ?? request.options.outputMode;
            if (configuredMode !== 'auto') {
                resolvedOutputModeByPage.set(pageNumber, configuredMode);
                continue;
            }
            const recommendation = request.outputModeRecommendations?.[String(pageNumber)];
            if (recommendation === undefined) {
                unresolvedAutoPages.push(pageNumber);
            } else {
                resolvedOutputModeByPage.set(pageNumber, recommendation);
            }
        }
        const probeDimensionsByPage = new Map<number, {
            dpi: number;
            width: number;
            height: number
        }>();
        if (unresolvedAutoPages.length > 0) {
            let analyzedRasterCount = 0;
            const analysisInputs = await mapScanCleanupRasterPages(
                unresolvedAutoPages,
                3,
                async pageNumber => {
                    signal.throwIfAborted();
                    const inputPath = join(scratch, `mode-analysis-${pageNumber}.png`);
                    await dependencies.renderPage(
                        paths,
                        log,
                        pageNumber,
                        prepared.pdfPath,
                        inputPath,
                        MODE_ANALYSIS_DPI,
                        undefined,
                        signal,
                    );
                    const dimensions = await readPngDimensions(inputPath);
                    probeDimensionsByPage.set(pageNumber, {
                        dpi: MODE_ANALYSIS_DPI,
                        ...dimensions,
                    });
                    analyzedRasterCount += 1;
                    emitProgress(
                        onProgress,
                        'rasterizing',
                        analyzedRasterCount,
                        unresolvedAutoPages.length,
                        5 + (10 * analyzedRasterCount / unresolvedAutoPages.length),
                    );
                    return {
                        inputPath,
                        pageNumber,
                        dpi: MODE_ANALYSIS_DPI,
                        sourceDpi: sourceDpiByPage.get(pageNumber)!,
                        requestedRenderDpi: MODE_ANALYSIS_DPI,
                        pageMetadataPath: join(scratch, `mode-analysis-${pageNumber}.json`),
                    };
                },
            );
            const analysisManifest = buildNativeScanCleanupManifest({
                operation: 'analyze',
                renderMode: 'final',
                canvasScope: 'page',
                qualityPath: 'raster',
                options: request.options,
                pages: analysisInputs,
            });
            const analysisManifestPath = join(scratch, 'mode-analysis-manifest.json');
            await writeFile(analysisManifestPath, JSON.stringify(analysisManifest));
            emitProgress(onProgress, 'classifying', 0, unresolvedAutoPages.length, 15, []);
            const classifiedPageNumbers = new Set<number>();
            await dependencies.runSidecar(
                paths.scanCleanupBinary,
                analysisManifestPath,
                signal,
                log,
                (_progress, nativeProgress) => {
                    if (nativeProgress.pageNumber !== undefined) {
                        classifiedPageNumbers.add(unresolvedAutoPages[nativeProgress.pageNumber - 1]!);
                    }
                    const completedUnits = classifiedPageNumbers.size;
                    emitProgress(
                        onProgress,
                        'classifying',
                        completedUnits,
                        unresolvedAutoPages.length,
                        15 + (10 * completedUnits / unresolvedAutoPages.length),
                        classifiedPageNumbers,
                    );
                },
            );
            for (const page of analysisManifest.pages) {
                const metadata = JSON.parse(
                    await readFile(page.pageMetadataPath, 'utf8'),
                ) as ICleanupPageMetadata;
                if (metadata.recommendedOutputMode === undefined) {
                    throw new Error(
                        `Automatic output-mode analysis returned no recommendation for page ${page.sourcePageIndex + 1}`,
                    );
                }
                resolvedOutputModeByPage.set(
                    page.sourcePageIndex + 1,
                    metadata.recommendedOutputMode,
                );
            }
        }
        const bwPages = pageNumbers.filter(
            pageNumber => resolvedOutputModeByPage.get(pageNumber) === 'bw',
        );
        const finalRasterStartPercent = unresolvedAutoPages.length > 0 ? 25 : 15;
        const probedBwPageNumbers = new Set(bwPages.filter(pageNumber => probeDimensionsByPage.has(pageNumber)));
        emitProgress(
            onProgress,
            'probing',
            probedBwPageNumbers.size,
            bwPages.length,
            finalRasterStartPercent,
            probedBwPageNumbers,
        );
        await mapScanCleanupRasterPages(
            bwPages.filter(pageNumber => !probeDimensionsByPage.has(pageNumber)),
            3,
            async pageNumber => {
                signal.throwIfAborted();
                const inputPath = join(scratch, `size-probe-${pageNumber}.png`);
                await dependencies.renderPage(
                    paths,
                    log,
                    pageNumber,
                    prepared.pdfPath,
                    inputPath,
                    SIZE_PROBE_DPI,
                    undefined,
                    signal,
                );
                probeDimensionsByPage.set(pageNumber, {
                    dpi: SIZE_PROBE_DPI,
                    ...await readPngDimensions(inputPath),
                });
                probedBwPageNumbers.add(pageNumber);
                emitProgress(
                    onProgress,
                    'probing',
                    probedBwPageNumbers.size,
                    bwPages.length,
                    finalRasterStartPercent,
                    probedBwPageNumbers,
                );
            },
        );
        const pageDpi = new Map<number, number>();
        let rasterizedCount = 0;
        const rasterizedPageNumbers = new Set<number>();
        const pageInputs = await mapScanCleanupRasterPages(pageNumbers, 3, async pageNumber => {
            signal.throwIfAborted();
            const sourceDpi = sourceDpiByPage.get(pageNumber)!;
            const resolvedOutputMode = resolvedOutputModeByPage.get(pageNumber) ?? 'color';
            // Bilevel output floors at 600 DPI: below that, thin strokes fragment
            // during binarization while 1-bit encoding keeps the byte cost small.
            const requestedRenderDpi = resolvedOutputMode === 'bw' ? Math.max(sourceDpi * 2, 600) : sourceDpi;
            const dpi = resolvedOutputMode === 'bw'
                ? resolveSafeRenderDpi(
                    requestedRenderDpi,
                    resolveScanCleanupPipelineMaxPixels(resolvedOutputMode),
                    probeDimensionsByPage.get(pageNumber)!,
                )
                : sourceDpi;
            pageDpi.set(pageNumber, dpi);
            const inputPath = join(scratch, `source-${pageNumber}.png`);
            await dependencies.renderPage(paths, log, pageNumber, prepared.pdfPath, inputPath, dpi, undefined, signal);
            const page = {
                inputPath,
                pageNumber,
                dpi,
                sourceDpi,
                requestedRenderDpi,
                resolvedOutputMode,
                pageMetadataPath: join(scratch, `clean-${pageNumber}-page.json`),
                outputs: [
                    0,
                    1,
                ].map(outputIndex => ({
                    outputPath: join(scratch, `clean-${pageNumber}-${outputIndex}.png`),
                    metadataPath: join(scratch, `clean-${pageNumber}-${outputIndex}.json`),
                    bilevelOutputPath: join(scratch, `clean-${pageNumber}-${outputIndex}.pbm`),
                    backgroundOutputPath: join(scratch, `clean-${pageNumber}-${outputIndex}-background.png`),
                    foregroundMaskOutputPath: join(scratch, `clean-${pageNumber}-${outputIndex}-mask.pbm`),
                })),
            };
            rasterizedCount += 1;
            rasterizedPageNumbers.add(pageNumber);
            emitProgress(
                onProgress,
                'rasterizing',
                rasterizedCount,
                pageCount,
                finalRasterStartPercent + (20 * rasterizedCount / pageCount),
                rasterizedPageNumbers,
            );
            return page;
        });
        const manifest = buildNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options: request.options,
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: pageInputs,
        });
        const pages = manifest.pages;
        const manifestPath = join(scratch, 'cleanup-manifest.json');
        await writeFile(manifestPath, JSON.stringify(manifest));
        emitProgress(onProgress, 'classifying', 0, pageCount, 45, []);
        const classifiedPageNumbers = new Set<number>();
        const renderedPageNumbers = new Set<number>();
        let renderingStarted = false;
        await dependencies.runSidecar(paths.scanCleanupBinary, manifestPath, signal, log, (_progress, nativeProgress) => {
            if (nativeProgress.stage === 'page-analyzed') {
                if (nativeProgress.pageNumber !== undefined) {
                    classifiedPageNumbers.add(pageNumbers[nativeProgress.pageNumber - 1]!);
                }
                const completedUnits = classifiedPageNumbers.size;
                emitProgress(
                    onProgress,
                    'classifying',
                    completedUnits,
                    pageCount,
                    45 + (15 * completedUnits / pageCount),
                    classifiedPageNumbers,
                );
                return;
            }
            if (nativeProgress.stage !== 'page-complete') {
                return;
            }
            if (!renderingStarted) {
                renderingStarted = true;
                emitProgress(onProgress, 'rendering', 0, pageCount, 60, []);
            }
            if (nativeProgress.pageNumber !== undefined) {
                renderedPageNumbers.add(pageNumbers[nativeProgress.pageNumber - 1]!);
            }
            const completedUnits = renderedPageNumbers.size;
            emitProgress(
                onProgress,
                'rendering',
                completedUnits,
                pageCount,
                60 + (15 * completedUnits / pageCount),
                renderedPageNumbers,
            );
        });
        const outputPages: Array<{
            path: string;
            bilevelPath?: string;
            backgroundPath?: string;
            foregroundMaskPath?: string;
            dpi: number;
            resolvedOutputMode: TScanCleanupOutputMode;
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
                    await stat(output.outputPath);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    continue;
                }
                const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8')) as ICleanupMetadata;
                let bilevelPath: string | undefined;
                if (metadata.bilevelWritten) {
                    try {
                        if (output.bilevelOutputPath === undefined) {
                            throw new Error('no bilevel output path was declared');
                        }
                        const bilevelStats = await stat(output.bilevelOutputPath);
                        if (!bilevelStats.isFile()) {
                            throw new Error('bilevel output path is not a file');
                        }
                        await access(output.bilevelOutputPath, fsConstants.R_OK);
                        bilevelPath = output.bilevelOutputPath;
                    } catch (error) {
                        log(
                            'warn',
                            `Page ${pageIndex + 1} bilevel output is missing or unreadable; using PNG fallback: ${(error as Error).message}`,
                        );
                    }
                }
                let backgroundPath: string | undefined;
                let foregroundMaskPath: string | undefined;
                if (metadata.layeredWritten) {
                    try {
                        if (
                            output.backgroundOutputPath === undefined
                            || output.foregroundMaskOutputPath === undefined
                        ) {
                            throw new Error('no mixed layer output paths were declared');
                        }
                        const [
                            backgroundStats,
                            maskStats,
                        ] = await Promise.all([
                            stat(output.backgroundOutputPath),
                            stat(output.foregroundMaskOutputPath),
                        ]);
                        if (!backgroundStats.isFile() || !maskStats.isFile()) {
                            throw new Error('a mixed layer output path is not a file');
                        }
                        await Promise.all([
                            access(output.backgroundOutputPath, fsConstants.R_OK),
                            access(output.foregroundMaskOutputPath, fsConstants.R_OK),
                        ]);
                        backgroundPath = output.backgroundOutputPath;
                        foregroundMaskPath = output.foregroundMaskOutputPath;
                    } catch (error) {
                        log(
                            'warn',
                            `Page ${pageIndex + 1} mixed layers are missing or unreadable; using composite JPEG fallback: ${(error as Error).message}`,
                        );
                    }
                }
                pageOutputPages.push({
                    path: output.outputPath,
                    ...(bilevelPath === undefined ? {} : {bilevelPath}),
                    ...(backgroundPath === undefined ? {} : {backgroundPath}),
                    ...(foregroundMaskPath === undefined ? {} : {foregroundMaskPath}),
                    dpi: metadata.renderDpi
                        ?? pageDpi.get(pageNumbers[pageIndex]!)
                        ?? documentDpi,
                    resolvedOutputMode: resolvedOutputModeByPage.get(pageIndex + 1) ?? 'color',
                    metadata,
                });
                if (!metadata.skewApplied) summary.deskewSkipped += 1;
                if (request.options.crop && metadata.contentBox == null) summary.cropSkipped += 1;
                summary.warnings.push(...(metadata.warnings ?? []).map(warning => `Page ${pageNumbers[pageIndex]}: ${warning}`));
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
        await writeFile(combineManifestPath, outputPages.map(output => {
            const pageSize = [
                (output.metadata.matchedCanvasTargetWidthPoints
                ?? output.metadata.canvasWidthPx / output.dpi * 72).toFixed(6),
                (output.metadata.matchedCanvasTargetHeightPoints
                ?? output.metadata.canvasHeightPx / output.dpi * 72).toFixed(6),
            ];
            if (output.bilevelPath !== undefined) {
                return [
                    'image-bilevel',
                    ...pageSize,
                    output.bilevelPath,
                ].join('\t');
            }
            if (
                output.backgroundPath !== undefined
                && output.foregroundMaskPath !== undefined
            ) {
                return [
                    'layered-jpeg',
                    ...pageSize,
                    SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
                    output.backgroundPath,
                    output.foregroundMaskPath,
                ].join('\t');
            }
            const jpegQuality = output.metadata.bilevelWritten
                ? undefined
                : resolveTonalJpegQuality(output.resolvedOutputMode);
            return jpegQuality === undefined
                ? [
                    'image',
                    ...pageSize,
                    output.path,
                ].join('\t')
                : [
                    'image-jpeg',
                    ...pageSize,
                    jpegQuality,
                    output.path,
                ].join('\t');
        }).join('\n') + '\n');
        emitProgress(onProgress, 'assembling', pageCount, pageCount, 82, pageNumbers);
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
        emitProgress(onProgress, 'handoff', pageCount, pageCount, 98, pageNumbers);
        await copyFile(stagedPdfPath, publishTempPath);
        if (signal.aborted) throw signal.reason;
        await rename(publishTempPath, request.outputPdfPath);
        emitProgress(onProgress, 'handoff', pageCount, pageCount, 100, pageNumbers);
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
