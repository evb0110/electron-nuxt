import {
    access,
    copyFile,
    mkdtemp,
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
    IScanCleanupSplitSeamPolyline,
    TScanCleanupProgress,
    TScanCleanupSummary,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import { getPdfPageCount } from '@electron/pdf/pdfPageCount';
import { detectSourceDpiDetails } from '@electron/pdf/sourceDpiDetection';
import {
    preparePdfForPoppler,
    renderPdfPageToPng,
    renderPdfPageToPpm,
} from '@electron/ocr/worker/popplerStage';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import { runScanCleanupSidecar } from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {buildNativeScanCleanupManifest} from '@electron/features/scan-cleanup/policy/buildNativeScanCleanupManifest';
import {resolveScanCleanupPipelineMaxPixels} from '@electron/features/scan-cleanup/policy/effectiveOptions';
import {
    readPbmDimensions,
    readPngDimensions,
} from '@electron/features/scan-cleanup/worker/rasterLayerDimensions';

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
    // The mode the native engine actually rendered with; for `auto` pages it
    // carries the resolution the assembler must honor.
    outputMode?: TScanCleanupOutputMode;
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
    renderPagePpm: typeof renderPdfPageToPpm;
    runSidecar: typeof runScanCleanupSidecar;
    runCommand: typeof runNativeToolCommand;
}

const defaultDependencies: IRunScanCleanupPipelineDependencies = {
    getPageCount: getPdfPageCount,
    detectSourceDpi: detectSourceDpiDetails,
    preparePdf: preparePdfForPoppler,
    renderPage: renderPdfPageToPng,
    renderPagePpm: renderPdfPageToPpm,
    runSidecar: runScanCleanupSidecar,
    runCommand: runNativeToolCommand,
};

const SCAN_CLEANUP_MAX_DIMENSION_PX = 40_000;
const SIZE_PROBE_DPI = 72;
const SCAN_CLEANUP_BILEVEL_FALLBACK_DPI = 600;
// PPM removes the costly PNG encode/decode step for small cleanup scopes, but
// retaining one uncompressed RGB raster for every page of a large book can
// consume several gigabytes. Keep the fast handoff only when the complete
// manifest has a known, bounded footprint; otherwise use compressed PNG.
const SCAN_CLEANUP_RAW_RASTER_BUDGET_BYTES = 512 * 1024 * 1024;
const PPM_HEADER_ESTIMATE_BYTES = 64;
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

interface IScanCleanupRasterHandoffPlan {
    renderDpi: number;
    raster: {
        dpi: number;
        width: number;
        height: number
    } | undefined;
}

function resolveRasterHandoff(
    plans: readonly IScanCleanupRasterHandoffPlan[],
) {
    let estimatedBytes = 0;
    for (const plan of plans) {
        const raster = plan.raster;
        if (
            raster === undefined
            || !Number.isFinite(plan.renderDpi)
            || plan.renderDpi <= 0
            || !Number.isFinite(raster.dpi)
            || raster.dpi <= 0
            || !Number.isFinite(raster.width)
            || raster.width <= 0
            || !Number.isFinite(raster.height)
            || raster.height <= 0
        ) {
            return {
                format: 'png' as const,
                estimatedBytes: null,
            };
        }
        const width = Math.max(1, Math.ceil(raster.width * plan.renderDpi / raster.dpi));
        const height = Math.max(1, Math.ceil(raster.height * plan.renderDpi / raster.dpi));
        const pageBytes = width * height * 3 + PPM_HEADER_ESTIMATE_BYTES;
        if (!Number.isSafeInteger(pageBytes)) {
            return {
                format: 'png' as const,
                estimatedBytes: null,
            };
        }
        estimatedBytes += pageBytes;
        if (
            !Number.isSafeInteger(estimatedBytes)
            || estimatedBytes > SCAN_CLEANUP_RAW_RASTER_BUDGET_BYTES
        ) {
            return {
                format: 'png' as const,
                estimatedBytes,
            };
        }
    }
    return {
        format: 'ppm' as const,
        estimatedBytes,
    };
}

function logRasterHandoff(
    log: TWorkerLog,
    scope: string,
    handoff: ReturnType<typeof resolveRasterHandoff>,
) {
    const footprint = handoff.estimatedBytes === null
        ? 'unknown footprint'
        : `${Math.ceil(handoff.estimatedBytes / (1024 * 1024))} MiB estimated footprint`;
    log('debug', `Scan cleanup ${scope} raster handoff uses ${handoff.format.toUpperCase()} (${footprint})`);
}

function emitProgress(
    callback: (progress: TScanCleanupProgress) => void,
    stage: TScanCleanupProgress['stage'],
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
    onProgress: (progress: TScanCleanupProgress) => void,
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
    const rasterPlans = pageNumbers.map(pageNumber => {
        const detected = dpiDetails.pageRasterByNumber.get(pageNumber);
        const dpi = resolveSourceDpi(detected?.dpi, documentDpi);
        return {
            pageNumber,
            dpi,
            raster: detected === undefined
                ? undefined
                : {
                    dpi: resolveSourceDpi(detected.dpi, documentDpi),
                    width: detected.width,
                    height: detected.height,
                },
        };
    });
    const rasterHandoff = resolveRasterHandoff(rasterPlans.map(plan => ({
        renderDpi: plan.dpi,
        raster: plan.raster,
    })));
    logRasterHandoff(log, 'lossless analysis', rasterHandoff);
    let rasterizedCount = 0;
    const rasterizedPageNumbers = new Set<number>();
    emitProgress(onProgress, 'rasterizing', 0, pageNumbers.length, 5, []);
    const pageInputs = await mapScanCleanupRasterPages(rasterPlans, 3, async plan => {
        signal.throwIfAborted();
        const extension = rasterHandoff.format;
        const inputPath = join(scratch, `analysis-${plan.pageNumber}.${extension}`);
        const renderer = extension === 'ppm'
            ? dependencies.renderPagePpm
            : dependencies.renderPage;
        await renderer(
            paths,
            log,
            plan.pageNumber,
            preparedPdfPath,
            inputPath,
            plan.dpi,
            undefined,
            signal,
        );
        rasterizedCount += 1;
        rasterizedPageNumbers.add(plan.pageNumber);
        emitProgress(onProgress, 'rasterizing', rasterizedCount, pageNumbers.length, 5 + (35 * rasterizedCount / pageNumbers.length), rasterizedPageNumbers);
        return {
            inputPath,
            pageNumber: plan.pageNumber,
            dpi: plan.dpi,
            pageMetadataPath: join(scratch, `analysis-${plan.pageNumber}.json`),
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

    const summary: TScanCleanupSummary = {
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
    onProgress: (progress: TScanCleanupProgress) => void,
    log: TWorkerLog = () => undefined,
    dependencies: IRunScanCleanupPipelineDependencies = defaultDependencies,
): Promise<TScanCleanupSummary> {
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
        const detectedRasterByPage = dpiDetails.pageRasterByNumber;
        const sourceDpiByPage = new Map(pageNumbers.map(pageNumber => [
            pageNumber,
            resolveSourceDpi(detectedRasterByPage.get(pageNumber)?.dpi, documentDpi),
        ]));
        const resolvedOutputModeByPage = new Map<number, TScanCleanupOutputMode>();
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
            // Pages without a recommendation stay `auto`: the single final
            // render resolves them natively from full-resolution evidence and
            // reports the resolution back through the page metadata.
            if (recommendation !== undefined) {
                resolvedOutputModeByPage.set(pageNumber, recommendation);
            }
        }
        const requiresBilevelQuality = (pageNumber: number) => {
            const mode = resolvedOutputModeByPage.get(pageNumber);
            return mode === undefined || mode === 'bw' || mode === 'mixed';
        };
        // Pixel guardrails come from the pdfimages raster row for detected
        // pages; only undetected pages that may produce a binary layer (and
        // therefore take the synthesis DPI floor) pay for a 72-DPI probe.
        const guardrailByPage = new Map<number, {
            dpi: number;
            width: number;
            height: number
        }>();
        for (const pageNumber of pageNumbers) {
            const detected = detectedRasterByPage.get(pageNumber);
            if (detected !== undefined) {
                guardrailByPage.set(pageNumber, {
                    dpi: sourceDpiByPage.get(pageNumber)!,
                    width: detected.width,
                    height: detected.height,
                });
            }
        }
        const probePages = pageNumbers.filter(
            pageNumber => !guardrailByPage.has(pageNumber) && requiresBilevelQuality(pageNumber),
        );
        if (probePages.length > 0) {
            const probedPageNumbers = new Set<number>();
            emitProgress(onProgress, 'probing', 0, probePages.length, 8, []);
            await mapScanCleanupRasterPages(probePages, 3, async pageNumber => {
                signal.throwIfAborted();
                const probePath = join(scratch, `size-probe-${pageNumber}.png`);
                await dependencies.renderPage(
                    paths,
                    log,
                    pageNumber,
                    prepared.pdfPath,
                    probePath,
                    SIZE_PROBE_DPI,
                    undefined,
                    signal,
                );
                guardrailByPage.set(pageNumber, {
                    dpi: SIZE_PROBE_DPI,
                    ...await readPngDimensions(probePath),
                });
                probedPageNumbers.add(pageNumber);
                emitProgress(
                    onProgress,
                    'probing',
                    probedPageNumbers.size,
                    probePages.length,
                    8,
                    probedPageNumbers,
                );
            });
        }
        const rasterPlans = pageNumbers.map(pageNumber => {
            const sourceDpi = sourceDpiByPage.get(pageNumber)!;
            const resolvedOutputMode = resolvedOutputModeByPage.get(pageNumber);
            const requestedRenderDpi = !detectedRasterByPage.has(pageNumber) && requiresBilevelQuality(pageNumber)
                ? Math.max(sourceDpi, SCAN_CLEANUP_BILEVEL_FALLBACK_DPI)
                : sourceDpi;
            const guardrail = guardrailByPage.get(pageNumber);
            const dpi = guardrail === undefined
                ? requestedRenderDpi
                : resolveSafeRenderDpi(
                    requestedRenderDpi,
                    resolveScanCleanupPipelineMaxPixels(resolvedOutputMode),
                    guardrail,
                );
            return {
                pageNumber,
                sourceDpi,
                resolvedOutputMode,
                requestedRenderDpi,
                dpi,
                guardrail,
            };
        });
        const rasterHandoff = resolveRasterHandoff(rasterPlans.map(plan => ({
            renderDpi: plan.dpi,
            raster: plan.guardrail,
        })));
        logRasterHandoff(log, 'final', rasterHandoff);
        const pageDpi = new Map<number, number>();
        let rasterizedCount = 0;
        const rasterizedPageNumbers = new Set<number>();
        emitProgress(onProgress, 'rasterizing', 0, pageCount, 15, []);
        const pageInputs = await mapScanCleanupRasterPages(rasterPlans, 3, async plan => {
            signal.throwIfAborted();
            pageDpi.set(plan.pageNumber, plan.dpi);
            const extension = rasterHandoff.format;
            const inputPath = join(scratch, `source-${plan.pageNumber}.${extension}`);
            const renderer = extension === 'ppm'
                ? dependencies.renderPagePpm
                : dependencies.renderPage;
            await renderer(
                paths,
                log,
                plan.pageNumber,
                prepared.pdfPath,
                inputPath,
                plan.dpi,
                undefined,
                signal,
            );
            const page = {
                inputPath,
                pageNumber: plan.pageNumber,
                dpi: plan.dpi,
                sourceDpi: plan.sourceDpi,
                requestedRenderDpi: plan.requestedRenderDpi,
                ...(plan.resolvedOutputMode === undefined ? {} : {resolvedOutputMode: plan.resolvedOutputMode}),
                pageMetadataPath: join(scratch, `clean-${plan.pageNumber}-page.json`),
                outputs: [
                    0,
                    1,
                ].map(outputIndex => ({
                    outputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}.png`),
                    metadataPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}.json`),
                    bilevelOutputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}.pbm`),
                    backgroundOutputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}-background.png`),
                    foregroundMaskOutputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}-mask.pbm`),
                })),
            };
            rasterizedCount += 1;
            rasterizedPageNumbers.add(plan.pageNumber);
            emitProgress(
                onProgress,
                'rasterizing',
                rasterizedCount,
                pageCount,
                15 + (20 * rasterizedCount / pageCount),
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
            backgroundIsColor?: boolean;
            dpi: number;
            resolvedOutputMode: TScanCleanupOutputMode;
            metadata: ICleanupMetadata
        }> = [];
        const summary: TScanCleanupSummary = {
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
                            `Page ${pageNumbers[pageIndex]} bilevel output is missing or unreadable; using PNG fallback: ${(error as Error).message}`,
                        );
                    }
                }
                let backgroundPath: string | undefined;
                let foregroundMaskPath: string | undefined;
                let backgroundIsColor: boolean | undefined;
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
                        const [
                            backgroundHeader,
                            maskHeader,
                        ] = await Promise.all([
                            readPngDimensions(output.backgroundOutputPath),
                            readPbmDimensions(output.foregroundMaskOutputPath),
                        ]);
                        const renderDpi = metadata.renderDpi
                            ?? pageDpi.get(pageNumbers[pageIndex]!)
                            ?? documentDpi;
                        const backgroundDpi = metadata.layeredBackgroundDpi;
                        if (
                            !Number.isFinite(renderDpi)
                            || renderDpi <= 0
                            || backgroundDpi === undefined
                            || !Number.isFinite(backgroundDpi)
                            || backgroundDpi <= 0
                        ) {
                            throw new Error('mixed layer DPI metadata is invalid');
                        }
                        const expectedBackgroundWidth = Math.max(
                            1,
                            Math.round(metadata.canvasWidthPx * backgroundDpi / renderDpi),
                        );
                        const expectedBackgroundHeight = Math.max(
                            1,
                            Math.round(metadata.canvasHeightPx * backgroundDpi / renderDpi),
                        );
                        if (
                            maskHeader.width !== metadata.canvasWidthPx
                            || maskHeader.height !== metadata.canvasHeightPx
                            || backgroundHeader.width !== expectedBackgroundWidth
                            || backgroundHeader.height !== expectedBackgroundHeight
                        ) {
                            throw new Error(
                                'mixed layer dimensions do not match metadata '
                                + `(background ${backgroundHeader.width}x${backgroundHeader.height}, `
                                + `expected ${expectedBackgroundWidth}x${expectedBackgroundHeight}; `
                                + `mask ${maskHeader.width}x${maskHeader.height}, `
                                + `expected ${metadata.canvasWidthPx}x${metadata.canvasHeightPx})`,
                            );
                        }
                        backgroundPath = output.backgroundOutputPath;
                        foregroundMaskPath = output.foregroundMaskOutputPath;
                        backgroundIsColor = backgroundHeader.isColor;
                    } catch (error) {
                        log(
                            'warn',
                            `Page ${pageNumbers[pageIndex]} mixed layers are missing, malformed, or mismatched; using composite JPEG fallback: ${(error as Error).message}`,
                        );
                    }
                }
                pageOutputPages.push({
                    path: output.outputPath,
                    ...(bilevelPath === undefined ? {} : {bilevelPath}),
                    ...(backgroundPath === undefined ? {} : {backgroundPath}),
                    ...(foregroundMaskPath === undefined ? {} : {foregroundMaskPath}),
                    ...(backgroundIsColor === undefined ? {} : {backgroundIsColor}),
                    dpi: metadata.renderDpi
                        ?? pageDpi.get(pageNumbers[pageIndex]!)
                        ?? documentDpi,
                    // The engine reports the mode it actually rendered with,
                    // which is the only authority once `auto` resolves natively.
                    resolvedOutputMode: metadata.outputMode
                        ?? resolvedOutputModeByPage.get(pageNumbers[pageIndex]!)
                        ?? 'color',
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
                    output.backgroundIsColor
                        ? SCAN_CLEANUP_COLOR_JPEG_QUALITY
                        : SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
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
