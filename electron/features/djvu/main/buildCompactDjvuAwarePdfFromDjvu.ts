import { randomUUID } from 'node:crypto';
import {
    mkdir,
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { limitAsync } from 'es-toolkit/array';
import type { IDjvuConversionPageMetrics } from '@contracts/djvuConversionPolicy';
import { buildDjvuRuntimeEnv } from '@electron/djvu/paths';
import { getDjvuNativeToolPaths } from '@electron/djvu/nativeToolPaths';
import {
    renderDjvuPageToImage,
    runRegisteredDjvuProcess,
} from '@electron/features/djvu/main/ddjvuConversion';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

interface ICompactDjvuPdfExportOptions {
    jobId: string;
    djvuPath: string;
    outputPath: string;
    tempDir: string;
    pageCount: number;
    sourceDpi: number;
    pageSizes: IDjvuConversionPageMetrics[] | null;
    signal?: AbortSignal;
    pages?: number[];
    onProgress?: (percent: number) => void;
}

interface ICompactPageSpec {
    pageNumber: number;
    manifestLine: string;
    kind: 'bitonal' | 'layered' | 'layered-color' | 'photo';
    reason: string;
}

interface INetpbmInfo {
    magic: 'P4' | 'P5' | 'P6';
    width: number;
    height: number;
    dataOffset: number;
}

interface INetpbmStats extends INetpbmInfo {
    nonWhiteRatio: number;
    darkRatio: number;
    colorRatio: number;
    maxDarkRunRatio: number;
    minChannel: number;
    maxChannel: number;
}

interface IForegroundColorAnalysis {
    dominantColor: [number, number, number];
    colorRatio: number;
}

interface IPbmMaskStats extends INetpbmInfo {
    blackRatio: number;
    maxBlackRunRatio: number;
}

interface IDjvuPageInfo {
    width: number;
    height: number;
    dpi: number;
}

interface IDjvuLayerInfo {
    present: boolean;
    kind: string;
    bytes: number;
    width?: number;
    height?: number;
    subsample?: number;
}

interface IDjvuPageStructure {
    pageNumber: number;
    pageBytes: number | null;
    info: IDjvuPageInfo | null;
    hasMask: boolean;
    maskBytes: number | null;
    background: IDjvuLayerInfo | null;
    foreground: IDjvuLayerInfo | null;
}

interface IMutableDjvuPageStructure extends IDjvuPageStructure { hasPageChunk: boolean; }

const logger = createLogger('djvu-compact-pdf');
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRESS_EXTRACTION_CAP = 86;
const PROGRESS_COMBINE_START = 88;
const PROGRESS_COMBINE_CAP = 94;
const DEFAULT_DPI = 300;
const FOREGROUND_COLOR_RATIO_MIN = 0.05;
const FOREGROUND_COLOR_SATURATION_MIN = 24;
const FOREGROUND_DOMINANT_NON_WHITE_MAX = 230;
const FOREGROUND_NEAR_BLACK_MAX = 80;
const BACKGROUND_FLAT_NON_WHITE_RATIO = 0.002;
const BACKGROUND_FLAT_MIN_CHANNEL = 220;
const BACKGROUND_FLAT_CHANNEL_RANGE = 20;
const BACKGROUND_FLAT_COLOR_RATIO = 0.02;
const DJVU_COMPACT_MAX_PAGE_WORKERS = 2;
const DJVU_COMPACT_FOREGROUND_SUBSAMPLE = 12;
const DJVU_COMPACT_BACKGROUND_JPEG_QUALITY = readBoundedIntegerEnv(
    'EVB_DJVU_COMPACT_BACKGROUND_JPEG_QUALITY',
    80,
    1,
    100,
);
const DJVU_COMPACT_PHOTO_JPEG_QUALITY = readBoundedIntegerEnv(
    'EVB_DJVU_COMPACT_PHOTO_JPEG_QUALITY',
    85,
    1,
    100,
);
const DJVU_COMPACT_PHOTO_PPI_CAP = readBoundedIntegerEnv(
    'EVB_DJVU_COMPACT_PHOTO_PPI_CAP',
    300,
    72,
    1200,
);
const DJVU_COMPACT_NETPBM_MAX_INPUT_BYTES = 192 * 1024 * 1024;
const DJVU_COMPACT_REAL_MASK_MIN_BYTES = 128;
const DJVU_COMPACT_DUMP_TIMEOUT_MS = 20_000;
const DJVU_COMPACT_DUMP_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const DJVU_COMPACT_DUMP_MAX_STDERR_BYTES = 1024 * 1024;
const DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE = 1;
const DJVU_COMPACT_MIN_SUBSAMPLE = 1;
const DJVU_COMPACT_MAX_SUBSAMPLE = 64;
const DJVU_COMPACT_LAYER_DIMENSION_MATCH_TOLERANCE = 0.25;
const DJVU_COMPACT_MAX_PAGE_BYTES = 0xffffffff;
const DJVU_COMPACT_INFO_REGEX = /\bINFO\b.*?(\d+)x(\d+).*?(\d+)\s*dpi/u;
const DJVU_COMPACT_CHUNK_REGEX = /^\s+([A-Za-z0-9]{4})\s+\[(\d+)\]/u;
const DJVU_COMPACT_DIMENSIONS_REGEX = /(\d+)x(\d+)/gu;
const DJVU_COMPACT_FORM_PAGE_REGEX = /\bFORM:DJVU\b\s+\[(\d+)\](?:.*?\[P(\d+)\])?(?:.*?\((\d+)\))?/u;
const DJVU_COMPACT_BACKGROUND_CHUNKS = new Set([
    'BG44',
    'BGjp',
    'BG2k',
    'PM44',
]);
const DJVU_COMPACT_FOREGROUND_CHUNKS = new Set([
    'FG44',
    'FGbz',
    'FGjp',
    'FG2k',
]);
const DJVU_COMPACT_MASK_CHUNKS = new Set(['Sjbz']);

export async function buildCompactDjvuAwarePdfFromDjvu(options: ICompactDjvuPdfExportOptions) {
    const pages = normalizePages(options.pages, options.pageCount);
    if (pages.length === 0) {
        return {
            success: false,
            outputPath: options.outputPath,
            fileSize: 0,
            error: 'No DjVu pages available for compact PDF export',
        };
    }

    const pageTempDir = join(options.tempDir, 'compact-pages');
    await mkdir(pageTempDir, {recursive: true});
    const pageStructures = await readDjvuPageStructures(options.djvuPath, options.jobId, options.signal);
    const workerCount = Math.min(DJVU_COMPACT_MAX_PAGE_WORKERS, pages.length);
    let completedPageCount = 0;
    let lastProgress = 0;
    const emitProgress = (percent: number) => {
        const nextProgress = Math.max(lastProgress, Math.min(PROGRESS_COMBINE_CAP, percent));
        lastProgress = nextProgress;
        options.onProgress?.(nextProgress);
    };
    const buildPageWithLimit = limitAsync(async (pageNumber: number) => {
        throwIfAborted(options.signal);
        const pageSpec = await buildCompactPageSpec(
            options,
            pageTempDir,
            pageNumber,
            pageStructures.get(pageNumber) ?? null,
        );
        throwIfAborted(options.signal);
        completedPageCount += 1;
        emitProgress(Math.round((completedPageCount / pages.length) * PROGRESS_EXTRACTION_CAP));
        return pageSpec;
    }, workerCount);

    const pageSpecs = await Promise.all(pages.map(buildPageWithLimit));
    const manifestPath = join(options.tempDir, 'compact-manifest.tsv');
    await writeFile(
        manifestPath,
        `${pageSpecs.map(spec => spec.manifestLine).join('\n')}\n`,
        'utf8',
    );
    emitProgress(PROGRESS_COMBINE_START);
    throwIfAborted(options.signal);

    const layeredCount = pageSpecs.filter(spec => spec.kind === 'layered').length;
    const layeredColorCount = pageSpecs.filter(spec => spec.kind === 'layered-color').length;
    const bitonalCount = pageSpecs.filter(spec => spec.kind === 'bitonal').length;
    const photoCount = pageSpecs.filter(spec => spec.kind === 'photo').length;
    logger.info(
        `[${options.jobId}] Compact DjVu PDF manifest ready: ${bitonalCount} bitonal, ${layeredCount} layered, ${layeredColorCount} layered-color, ${photoCount} photo page(s)`,
    );

    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        return {
            success: false,
            outputPath: options.outputPath,
            fileSize: 0,
            error: 'Native PDF image combiner is unavailable',
        };
    }
    throwIfAborted(options.signal);

    const result = await runRegisteredDjvuProcess(
        `${options.jobId}-compact-combine`,
        binaryPath,
        [
            '--output',
            options.outputPath,
            '--json-progress',
            '--compact-manifest',
            manifestPath,
        ],
        {
            env: {
                ...process.env,
                EVB_PDF_COMBINE_MAX_PAGES: String(Math.max(pageSpecs.length, 1)),
            },
            onStdout: createNativeProgressHandler(pageSpecs.length, emitProgress),
        },
    );
    if (!result.success) {
        return {
            success: false,
            outputPath: options.outputPath,
            fileSize: 0,
            error: result.error,
        };
    }

    try {
        const s = await stat(options.outputPath);
        emitProgress(PROGRESS_COMBINE_CAP);
        return {
            success: true,
            outputPath: options.outputPath,
            fileSize: s.size,
            pageSpecs,
        };
    } catch (error) {
        return {
            success: false,
            outputPath: options.outputPath,
            fileSize: 0,
            error: `Compact PDF output file not found: ${getErrorMessage(error)}`,
        };
    }
}

async function readDjvuPageStructures(
    djvuPath: string,
    jobId: string,
    signal: AbortSignal | undefined,
): Promise<Map<number, IDjvuPageStructure>> {
    try {
        const { djvudump } = getDjvuNativeToolPaths();
        const result = await runNativeCommand(djvudump, [djvuPath], {
            env: buildDjvuRuntimeEnv(),
            timeoutMs: DJVU_COMPACT_DUMP_TIMEOUT_MS,
            maxStdoutBytes: DJVU_COMPACT_DUMP_MAX_STDOUT_BYTES,
            maxStderrBytes: DJVU_COMPACT_DUMP_MAX_STDERR_BYTES,
            commandLabel: 'djvudump',
            defaultCwdToCommandDir: true,
            prependCommandDirToPath: true,
            includeProcessEnv: true,
            windowsHide: true,
            ...(signal ? { signal } : {}),
        });
        const structures = parseDjvuPageStructures(result.stdout);
        if (structures.size > 0) {
            logger.debug(`[${jobId}] Read DjVu native layer structure for ${structures.size} page(s)`);
        }
        return structures;
    } catch (error) {
        logger.warn(`[${jobId}] DjVu layer structure read failed; using capped photo rendering: ${getErrorMessage(error)}`);
        return new Map();
    }
}

function parseDjvuPageStructures(stdout: string) {
    const structures = new Map<number, IDjvuPageStructure>();
    let current: IMutableDjvuPageStructure | null = null;
    let nextImplicitPageNumber = 1;
    const flushCurrent = () => {
        if (!current?.hasPageChunk) {
            return;
        }
        structures.set(current.pageNumber, {
            pageNumber: current.pageNumber,
            pageBytes: current.pageBytes,
            info: current.info,
            hasMask: current.hasMask,
            maskBytes: current.maskBytes,
            background: current.background,
            foreground: current.foreground,
        });
    };

    for (const line of stdout.split(/\r?\n/u)) {
        const pageMatch = line.match(DJVU_COMPACT_FORM_PAGE_REGEX);
        if (pageMatch) {
            flushCurrent();
            const pageNumber = parsePositiveInteger(pageMatch[2])
                ?? parsePositiveInteger(pageMatch[3])
                ?? nextImplicitPageNumber;
            nextImplicitPageNumber = Math.max(nextImplicitPageNumber, pageNumber + 1);
            current = {
                pageNumber,
                pageBytes: parseBoundedInteger(pageMatch[1], 0, DJVU_COMPACT_MAX_PAGE_BYTES),
                info: null,
                hasMask: false,
                hasPageChunk: true,
                maskBytes: null,
                background: null,
                foreground: null,
            };
            continue;
        }

        if (!current) {
            continue;
        }

        const infoMatch = line.match(DJVU_COMPACT_INFO_REGEX);
        if (infoMatch?.[1] && infoMatch[2] && infoMatch[3]) {
            current.info = {
                width: Number.parseInt(infoMatch[1], 10),
                height: Number.parseInt(infoMatch[2], 10),
                dpi: Number.parseInt(infoMatch[3], 10),
            };
            continue;
        }

        const chunkMatch = line.match(DJVU_COMPACT_CHUNK_REGEX);
        if (!chunkMatch?.[1] || !chunkMatch[2]) {
            continue;
        }

        const chunkId = chunkMatch[1];
        const chunkBytes = Number.parseInt(chunkMatch[2], 10);
        if (!Number.isFinite(chunkBytes) || chunkBytes < 0) {
            continue;
        }
        const dimensions = lastDimensions(line);
        const layer = createDjvuLayerInfo(chunkId, chunkBytes, dimensions, current.info);

        if (DJVU_COMPACT_MASK_CHUNKS.has(chunkId)) {
            current.hasMask = true;
            current.maskBytes = chunkBytes;
        } else if (DJVU_COMPACT_BACKGROUND_CHUNKS.has(chunkId)) {
            current.background = layer;
        } else if (DJVU_COMPACT_FOREGROUND_CHUNKS.has(chunkId)) {
            current.foreground = layer;
        }
    }
    flushCurrent();
    return structures;
}

function createDjvuLayerInfo(
    kind: string,
    bytes: number,
    dimensions: {
        width: number;
        height: number
    } | null,
    pageInfo: IDjvuPageInfo | null,
): IDjvuLayerInfo {
    return {
        present: true,
        kind,
        bytes,
        ...(dimensions ?? {}),
        ...(dimensions && pageInfo ? {subsample: deriveLayerSubsample(pageInfo, dimensions)} : {}),
    };
}

function lastDimensions(line: string) {
    let match: RegExpExecArray | null;
    let dimensions: {
        width: number;
        height: number
    } | null = null;
    DJVU_COMPACT_DIMENSIONS_REGEX.lastIndex = 0;
    while ((match = DJVU_COMPACT_DIMENSIONS_REGEX.exec(line)) !== null) {
        const width = parsePositiveInteger(match[1]);
        const height = parsePositiveInteger(match[2]);
        if (width !== null && height !== null) {
            dimensions = {
                width,
                height,
            };
        }
    }
    return dimensions;
}

function deriveLayerSubsample(
    pageInfo: IDjvuPageInfo,
    dimensions: {
        width: number;
        height: number
    },
) {
    if (dimensions.width <= 0 || dimensions.height <= 0) {
        return DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE;
    }
    const widthRatio = pageInfo.width / dimensions.width;
    const heightRatio = pageInfo.height / dimensions.height;
    const rounded = Math.round(Math.max(widthRatio, heightRatio));
    if (
        !Number.isFinite(rounded)
        || rounded < DJVU_COMPACT_MIN_SUBSAMPLE
        || Math.abs(widthRatio - heightRatio) > DJVU_COMPACT_LAYER_DIMENSION_MATCH_TOLERANCE * Math.max(1, rounded)
    ) {
        return DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE;
    }
    return Math.min(DJVU_COMPACT_MAX_SUBSAMPLE, Math.max(DJVU_COMPACT_MIN_SUBSAMPLE, rounded));
}

function hasRealForegroundMask(structure: IDjvuPageStructure) {
    return structure.hasMask
        && typeof structure.maskBytes === 'number'
        && structure.maskBytes >= DJVU_COMPACT_REAL_MASK_MIN_BYTES;
}

function parsePositiveInteger(value: string | undefined) {
    return parseBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function parseBoundedInteger(value: string | undefined, minValue: number, maxValue: number) {
    if (value === undefined) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < minValue || parsed > maxValue) {
        return null;
    }
    return parsed;
}

async function buildCompactPageSpec(
    options: ICompactDjvuPdfExportOptions,
    pageTempDir: string,
    pageNumber: number,
    structure: IDjvuPageStructure | null,
): Promise<ICompactPageSpec> {
    const pagePrefix = join(pageTempDir, `page-${String(pageNumber).padStart(5, '0')}-${randomUUID()}`);
    if (!structure) {
        return buildPhotoPageSpec(options, pagePrefix, pageNumber, null, 'DjVu layer structure unavailable; rendering capped photo page');
    }

    if (!hasRealForegroundMask(structure)) {
        return buildPhotoPageSpec(
            options,
            pagePrefix,
            pageNumber,
            structure,
            noRealMaskPhotoReason(structure),
        );
    }

    const maskPath = await renderMaskLayer(options, pagePrefix, pageNumber);
    const maskStats = await readPbmMaskStats(maskPath);
    const pageSize = resolvePageSizePoints(
        options.pageSizes?.[pageNumber - 1] ?? null,
        options.sourceDpi,
        maskStats,
        1,
        structure,
    );

    if (!structure.background) {
        return {
            pageNumber,
            kind: 'bitonal',
            reason: 'DjVu page has only a foreground mask',
            manifestLine: createManifestLine('mask', pageSize, [maskPath]),
        };
    }

    const backgroundPath = await renderBackgroundLayer(options, pagePrefix, pageNumber, structure);
    const backgroundStats = await readNetpbmStats(backgroundPath);
    if (isFlatBackground(backgroundStats)) {
        return {
            pageNumber,
            kind: 'bitonal',
            reason: 'foreground mask over flat background',
            manifestLine: createManifestLine('mask', pageSize, [maskPath]),
        };
    }

    const foregroundColorPath = structure.foreground
        ? await renderForegroundLayer(options, pagePrefix, pageNumber, structure)
        : null;
    const foregroundColor = foregroundColorPath
        ? await analyzeForegroundColor(foregroundColorPath)
        : null;

    if (foregroundColor && hasRealForegroundColor(foregroundColor)) {
        return {
            pageNumber,
            kind: 'layered-color',
            reason: 'DjVu native background, mask, and colored foreground layers',
            manifestLine: createManifestLine(
                'layered-color-jpeg',
                pageSize,
                [
                    backgroundPath,
                    maskPath,
                ],
                {
                    foregroundColor: foregroundColor.dominantColor,
                    jpegQuality: DJVU_COMPACT_BACKGROUND_JPEG_QUALITY,
                },
            ),
        };
    }

    return {
        pageNumber,
        kind: 'layered',
        reason: 'DjVu native mask and background layers',
        manifestLine: createManifestLine(
            'layered-jpeg',
            pageSize,
            [
                backgroundPath,
                maskPath,
            ],
            {jpegQuality: DJVU_COMPACT_BACKGROUND_JPEG_QUALITY},
        ),
    };
}

async function renderMaskLayer(
    options: ICompactDjvuPdfExportOptions,
    pagePrefix: string,
    pageNumber: number,
) {
    const outputPath = `${pagePrefix}-mask.pbm`;
    throwIfAborted(options.signal);
    const result = await renderDjvuPageToImage(
        options.djvuPath,
        outputPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-mask`,
        {
            format: 'pbm',
            mode: 'mask',
        },
    );
    throwIfCanceledRenderResult(result, options.signal);
    if (!result.success) {
        throw new Error(result.error ?? `Failed to render DjVu foreground mask for page ${pageNumber}`);
    }
    return outputPath;
}

async function renderBackgroundLayer(
    options: ICompactDjvuPdfExportOptions,
    pagePrefix: string,
    pageNumber: number,
    structure: IDjvuPageStructure,
) {
    const outputPath = `${pagePrefix}-background.ppm`;
    throwIfAborted(options.signal);
    const result = await renderDjvuPageToImage(
        options.djvuPath,
        outputPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-background`,
        {
            format: 'ppm',
            mode: 'background',
            subsample: nativeSubsample(structure.background),
        },
    );
    throwIfCanceledRenderResult(result, options.signal);
    if (!result.success) {
        throw new Error(result.error ?? `Failed to render DjVu background layer for page ${pageNumber}`);
    }
    return outputPath;
}

async function renderForegroundLayer(
    options: ICompactDjvuPdfExportOptions,
    pagePrefix: string,
    pageNumber: number,
    structure: IDjvuPageStructure,
) {
    const outputPath = `${pagePrefix}-foreground.ppm`;
    throwIfAborted(options.signal);
    const result = await renderDjvuPageToImage(
        options.djvuPath,
        outputPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-foreground`,
        {
            format: 'ppm',
            mode: 'foreground',
            subsample: nativeSubsample(structure.foreground, DJVU_COMPACT_FOREGROUND_SUBSAMPLE),
        },
    );
    throwIfCanceledRenderResult(result, options.signal);
    if (!result.success) {
        throw new Error(result.error ?? `Failed to render DjVu foreground layer for page ${pageNumber}`);
    }
    return outputPath;
}

async function buildPhotoPageSpec(
    options: ICompactDjvuPdfExportOptions,
    pagePrefix: string,
    pageNumber: number,
    structure: IDjvuPageStructure | null,
    reason: string,
): Promise<ICompactPageSpec> {
    throwIfAborted(options.signal);
    const photoPath = `${pagePrefix}-photo.ppm`;
    const renderOptions = resolvePhotoRenderOptions(options, pageNumber, structure);
    const result = await renderDjvuPageToImage(
        options.djvuPath,
        photoPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-photo`,
        renderOptions,
    );
    throwIfCanceledRenderResult(result, options.signal);
    if (!result.success) {
        throw new Error(result.error ?? `Failed to render compact photo page ${pageNumber}`);
    }

    const photoStats = await readNetpbmStats(photoPath);
    const pageSize = resolvePageSizePoints(
        options.pageSizes?.[pageNumber - 1] ?? null,
        options.sourceDpi,
        photoStats,
        renderOptions.subsample ?? DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE,
        structure,
    );
    return {
        pageNumber,
        kind: 'photo',
        reason,
        manifestLine: createManifestLine(
            'photo-jpeg',
            pageSize,
            [photoPath],
            {
                jpegQuality: DJVU_COMPACT_PHOTO_JPEG_QUALITY,
                ppiCap: DJVU_COMPACT_PHOTO_PPI_CAP,
            },
        ),
    };
}

function resolvePhotoRenderOptions(
    options: ICompactDjvuPdfExportOptions,
    pageNumber: number,
    structure: IDjvuPageStructure | null,
) {
    const pageInfo = structure?.info;
    const metrics = options.pageSizes?.[pageNumber - 1] ?? null;
    const dpi = positiveNumber(pageInfo?.dpi) ?? positiveNumber(options.sourceDpi) ?? DEFAULT_DPI;
    const width = positiveNumber(metrics?.width) ?? positiveNumber(pageInfo?.width);
    const height = positiveNumber(metrics?.height) ?? positiveNumber(pageInfo?.height);
    if (width && height) {
        const scale = Math.max(1, dpi / DJVU_COMPACT_PHOTO_PPI_CAP);
        return {
            format: 'ppm' as const,
            targetWidthPx: Math.max(1, Math.round(width / scale)),
            targetHeightPx: Math.max(1, Math.round(height / scale)),
        };
    }

    return {
        format: 'ppm' as const,
        subsample: Math.max(1, Math.ceil(dpi / DJVU_COMPACT_PHOTO_PPI_CAP)),
    };
}

function noRealMaskPhotoReason(structure: IDjvuPageStructure) {
    if (structure.background) {
        const maskDescription = structure.maskBytes === null
            ? 'without a foreground mask'
            : `with tiny foreground mask (${structure.maskBytes} bytes)`;
        return `DjVu page has continuous-tone background ${maskDescription}; rendering capped photo page`;
    }
    return 'DjVu page has no real foreground mask; rendering capped photo page';
}

function nativeSubsample(layer: IDjvuLayerInfo | null, fallback = DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE) {
    const subsample = layer?.subsample ?? fallback;
    return Math.min(DJVU_COMPACT_MAX_SUBSAMPLE, Math.max(DJVU_COMPACT_MIN_SUBSAMPLE, subsample));
}

async function analyzeForegroundColor(foregroundPath: string): Promise<IForegroundColorAnalysis> {
    const stats = await readNetpbmStats(foregroundPath);
    return {
        dominantColor: await readDominantForegroundColor(foregroundPath),
        colorRatio: stats.colorRatio,
    };
}

function hasRealForegroundColor(analysis: IForegroundColorAnalysis) {
    const spread = colorSpread(analysis.dominantColor);
    const maxChannel = Math.max(...analysis.dominantColor);
    return analysis.colorRatio > FOREGROUND_COLOR_RATIO_MIN
        && spread > FOREGROUND_COLOR_SATURATION_MIN
        && maxChannel >= FOREGROUND_NEAR_BLACK_MAX;
}

function resolveNativePdfImageCombinePath() {
    const isPackaged = __dirname.includes('app.asar');
    const binaryName = process.platform === 'win32'
        ? 'evb-pdf-image-combine.exe'
        : 'evb-pdf-image-combine';
    return resolveNativeToolPath({
        binaryName,
        crateName: 'pdf-image-combine',
        currentDir: __dirname,
        envOverridePath: process.env.EVB_PDF_IMAGE_COMBINE_PATH,
        isPackaged,
    });
}

function normalizePages(pages: number[] | undefined, pageCount: number) {
    if (pages) {
        return pages.filter(page => Number.isInteger(page) && page >= 1 && page <= pageCount);
    }
    return Array.from({length: pageCount}, (_value, index) => index + 1);
}

function resolvePageSizePoints(
    metrics: IDjvuConversionPageMetrics | null,
    sourceDpi: number,
    renderedInfo: Pick<INetpbmInfo, 'width' | 'height'>,
    renderedSubsample: number,
    structure: IDjvuPageStructure | null = null,
) {
    const dpi = positiveNumber(structure?.info?.dpi)
        ?? positiveNumber(sourceDpi)
        ?? DEFAULT_DPI;
    const width = positiveNumber(metrics?.width)
        ?? positiveNumber(structure?.info?.width)
        ?? renderedInfo.width * renderedSubsample;
    const height = positiveNumber(metrics?.height)
        ?? positiveNumber(structure?.info?.height)
        ?? renderedInfo.height * renderedSubsample;
    return {
        widthPoints: pointsFromPixels(width, dpi),
        heightPoints: pointsFromPixels(height, dpi),
    };
}

function pointsFromPixels(pixels: number, dpi: number) {
    return Math.max(1, pixels / Math.max(1, dpi) * 72);
}

function positiveNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

type TCompactManifestKind = 'image' | 'image-jpeg' | 'photo-jpeg' | 'layered' | 'layered-jpeg' | 'layered-color-jpeg' | 'mask';

function createManifestLine(
    kind: TCompactManifestKind,
    pageSize: {
        widthPoints: number;
        heightPoints: number;
    },
    paths: string[],
    options: {
        jpegQuality?: number;
        ppiCap?: number;
        foregroundColor?: [number, number, number];
    } = {},
) {
    for (const path of paths) {
        if (!canRepresentManifestPath(path)) {
            throw new Error(`Compact PDF manifest path is not representable: ${path}`);
        }
    }
    const fields = [
        kind,
        pageSize.widthPoints.toFixed(4),
        pageSize.heightPoints.toFixed(4),
    ];
    if (kind === 'image-jpeg' || kind === 'layered-jpeg' || kind === 'layered-color-jpeg') {
        fields.push(String(options.jpegQuality ?? DJVU_COMPACT_BACKGROUND_JPEG_QUALITY));
    }
    if (kind === 'photo-jpeg') {
        fields.push(
            String(options.jpegQuality ?? DJVU_COMPACT_PHOTO_JPEG_QUALITY),
            String(options.ppiCap ?? DJVU_COMPACT_PHOTO_PPI_CAP),
        );
    }
    fields.push(...paths);
    if (kind === 'layered-color-jpeg') {
        const color = options.foregroundColor ?? [
            0,
            0,
            0,
        ];
        fields.push(...color.map(channel => String(Math.min(255, Math.max(0, Math.round(channel))))));
    }
    return fields.join('\t');
}

function canRepresentManifestPath(path: string) {
    return path.length > 0
        && path.trim() === path
        && !/[\r\n\t]/u.test(path);
}

async function readNetpbmStats(path: string) {
    await assertNetpbmReadSafe(path);
    const data = await readFile(path);
    const info = parseNetpbmInfo(data);
    if (info.magic === 'P4') {
        throw new Error('PBM foreground probes are not supported');
    }

    const payload = data.subarray(info.dataOffset);
    const totalPixels = info.width * info.height;
    let nonWhitePixels = 0;
    let darkPixels = 0;
    let colorPixels = 0;
    let maxDarkRun = 0;
    let minChannel = 255;
    let maxChannel = 0;

    if (info.magic === 'P5') {
        for (let y = 0; y < info.height; y += 1) {
            let darkRun = 0;
            for (let x = 0; x < info.width; x += 1) {
                const value = payload[y * info.width + x] ?? 255;
                minChannel = Math.min(minChannel, value);
                maxChannel = Math.max(maxChannel, value);
                const isNonWhite = value < 245;
                const isDark = value < 80;
                if (isNonWhite) {
                    nonWhitePixels += 1;
                }
                if (isDark) {
                    darkPixels += 1;
                    darkRun += 1;
                    maxDarkRun = Math.max(maxDarkRun, darkRun);
                } else {
                    darkRun = 0;
                }
            }
        }
    } else {
        for (let y = 0; y < info.height; y += 1) {
            let darkRun = 0;
            for (let x = 0; x < info.width; x += 1) {
                const offset = (y * info.width + x) * 3;
                const red = payload[offset] ?? 255;
                const green = payload[offset + 1] ?? 255;
                const blue = payload[offset + 2] ?? 255;
                const min = Math.min(red, green, blue);
                const max = Math.max(red, green, blue);
                minChannel = Math.min(minChannel, min);
                maxChannel = Math.max(maxChannel, max);
                const isNonWhite = red < 245 || green < 245 || blue < 245;
                const isDark = red < 80 && green < 80 && blue < 80;
                if (isNonWhite) {
                    nonWhitePixels += 1;
                    if (max - min > 12) {
                        colorPixels += 1;
                    }
                }
                if (isDark) {
                    darkPixels += 1;
                    darkRun += 1;
                    maxDarkRun = Math.max(maxDarkRun, darkRun);
                } else {
                    darkRun = 0;
                }
            }
        }
    }

    return {
        ...info,
        nonWhiteRatio: nonWhitePixels / totalPixels,
        darkRatio: darkPixels / totalPixels,
        colorRatio: colorPixels / Math.max(1, nonWhitePixels),
        maxDarkRunRatio: maxDarkRun / Math.max(1, info.width),
        minChannel,
        maxChannel,
    } satisfies INetpbmStats;
}

async function readDominantForegroundColor(path: string): Promise<[number, number, number]> {
    await assertNetpbmReadSafe(path);
    const data = await readFile(path);
    const info = parseNetpbmInfo(data);
    if (info.magic === 'P4') {
        throw new Error('PBM foreground color probes are not supported');
    }

    const payload = data.subarray(info.dataOffset);
    let redTotal = 0;
    let greenTotal = 0;
    let blueTotal = 0;
    let weightTotal = 0;

    if (info.magic === 'P5') {
        for (let index = 0; index < info.width * info.height; index += 1) {
            const value = payload[index] ?? 255;
            if (value >= FOREGROUND_DOMINANT_NON_WHITE_MAX) {
                continue;
            }
            const weight = 255 - value;
            redTotal += value * weight;
            greenTotal += value * weight;
            blueTotal += value * weight;
            weightTotal += weight;
        }
    } else {
        for (let index = 0; index < info.width * info.height; index += 1) {
            const offset = index * 3;
            const red = payload[offset] ?? 255;
            const green = payload[offset + 1] ?? 255;
            const blue = payload[offset + 2] ?? 255;
            const max = Math.max(red, green, blue);
            if (max >= FOREGROUND_DOMINANT_NON_WHITE_MAX) {
                continue;
            }
            const weight = 255 - max;
            redTotal += red * weight;
            greenTotal += green * weight;
            blueTotal += blue * weight;
            weightTotal += weight;
        }
    }

    if (weightTotal <= 0) {
        return [
            0,
            0,
            0,
        ];
    }
    return [
        Math.round(redTotal / weightTotal),
        Math.round(greenTotal / weightTotal),
        Math.round(blueTotal / weightTotal),
    ];
}

function colorSpread(color: [number, number, number]) {
    return Math.max(...color) - Math.min(...color);
}

async function readPbmMaskStats(path: string) {
    await assertNetpbmReadSafe(path);
    const data = await readFile(path);
    const info = parseNetpbmInfo(data);
    if (info.magic !== 'P4') {
        throw new Error(`Unsupported foreground mask magic: ${info.magic}`);
    }

    const rowStride = Math.ceil(info.width / 8);
    const payload = data.subarray(info.dataOffset);
    const expectedBytes = rowStride * info.height;
    if (payload.byteLength < expectedBytes) {
        throw new Error('Truncated PBM foreground mask payload');
    }

    let blackPixels = 0;
    let maxBlackRun = 0;
    for (let y = 0; y < info.height; y += 1) {
        let blackRun = 0;
        const rowOffset = y * rowStride;
        for (let x = 0; x < info.width; x += 1) {
            const byte = payload[rowOffset + Math.floor(x / 8)] ?? 0;
            const bit = (byte & (0x80 >> (x % 8))) !== 0;
            if (bit) {
                blackPixels += 1;
                blackRun += 1;
                maxBlackRun = Math.max(maxBlackRun, blackRun);
            } else {
                blackRun = 0;
            }
        }
    }

    const totalPixels = info.width * info.height;
    return {
        ...info,
        blackRatio: blackPixels / totalPixels,
        maxBlackRunRatio: maxBlackRun / Math.max(1, info.width),
    } satisfies IPbmMaskStats;
}

function isFlatBackground(stats: INetpbmStats) {
    if (stats.nonWhiteRatio <= BACKGROUND_FLAT_NON_WHITE_RATIO) {
        return true;
    }

    const colorTotalRatio = stats.colorRatio * stats.nonWhiteRatio;
    return stats.darkRatio === 0
        && stats.minChannel >= BACKGROUND_FLAT_MIN_CHANNEL
        && stats.maxChannel - stats.minChannel <= BACKGROUND_FLAT_CHANNEL_RANGE
        && colorTotalRatio <= BACKGROUND_FLAT_COLOR_RATIO;
}

async function assertNetpbmReadSafe(path: string) {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
        throw new Error(`Netpbm input is not a regular file: ${path}`);
    }
    if (fileStat.size > DJVU_COMPACT_NETPBM_MAX_INPUT_BYTES) {
        const maxMb = Math.floor(DJVU_COMPACT_NETPBM_MAX_INPUT_BYTES / (1024 * 1024));
        throw new Error(`Netpbm input exceeds safe read limit (${maxMb}MB): ${path}`);
    }
}

function parseNetpbmInfo(data: Buffer): INetpbmInfo {
    if (data.byteLength < 4) {
        throw new Error('Netpbm payload is too short');
    }
    const magic = data.subarray(0, 2).toString('ascii');
    if (magic !== 'P4' && magic !== 'P5' && magic !== 'P6') {
        throw new Error(`Unsupported Netpbm magic: ${magic}`);
    }

    const state = {offset: 2};
    const width = readNetpbmNumber(data, state, 'width');
    const height = readNetpbmNumber(data, state, 'height');
    if (magic !== 'P4') {
        const maxValue = readNetpbmNumber(data, state, 'max value');
        if (maxValue !== 255) {
            throw new Error(`Unsupported Netpbm max value: ${maxValue}`);
        }
    }
    if (state.offset >= data.byteLength || !isWhitespaceByte(data[state.offset]!)) {
        throw new Error('Invalid Netpbm header terminator');
    }
    state.offset += data[state.offset] === 0x0d && data[state.offset + 1] === 0x0a ? 2 : 1;
    if (width <= 0 || height <= 0) {
        throw new Error('Invalid Netpbm dimensions');
    }

    return {
        magic,
        width,
        height,
        dataOffset: state.offset,
    };
}

function readNetpbmNumber(
    data: Buffer,
    state: {offset: number},
    label: string,
) {
    skipNetpbmWhitespaceAndComments(data, state);
    let raw = '';
    while (state.offset < data.byteLength && !isWhitespaceByte(data[state.offset]!)) {
        raw += String.fromCharCode(data[state.offset]!);
        state.offset += 1;
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid Netpbm ${label}`);
    }
    return value;
}

function skipNetpbmWhitespaceAndComments(data: Buffer, state: {offset: number}) {
    while (state.offset < data.byteLength) {
        const byte = data[state.offset]!;
        if (isWhitespaceByte(byte)) {
            state.offset += 1;
            continue;
        }
        if (byte === 0x23) {
            while (state.offset < data.byteLength && data[state.offset] !== 0x0a) {
                state.offset += 1;
            }
            continue;
        }
        break;
    }
}

function isWhitespaceByte(byte: number) {
    return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function createNativeProgressHandler(totalPages: number, emitProgress: (percent: number) => void) {
    let buffer = '';
    return (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            try {
                const payload = JSON.parse(line) as {
                    processed?: unknown;
                    total?: unknown;
                };
                const processed = typeof payload.processed === 'number' ? payload.processed : 0;
                const total = typeof payload.total === 'number' && payload.total > 0
                    ? payload.total
                    : totalPages;
                emitProgress(PROGRESS_COMBINE_START + Math.round(
                    (processed / Math.max(1, total)) * (PROGRESS_COMBINE_CAP - PROGRESS_COMBINE_START),
                ));
            } catch {
                logger.debug(`Ignoring malformed native compact PDF progress: ${line}`);
            }
        }
    };
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw new Error('DjVu conversion canceled');
    }
}

function throwIfCanceledRenderResult(
    result: {
        success: boolean;
        error?: string;
    },
    signal: AbortSignal | undefined,
) {
    throwIfAborted(signal);
    if (!result.success && result.error?.includes('DjVu conversion canceled')) {
        throw new Error('DjVu conversion canceled');
    }
}

function readBoundedIntegerEnv(
    name: string,
    defaultValue: number,
    minValue: number,
    maxValue: number,
) {
    const parsed = Number.parseInt(process.env[name] ?? `${defaultValue}`, 10);
    if (!Number.isFinite(parsed) || parsed < minValue) {
        return defaultValue;
    }
    return Math.min(parsed, maxValue);
}
