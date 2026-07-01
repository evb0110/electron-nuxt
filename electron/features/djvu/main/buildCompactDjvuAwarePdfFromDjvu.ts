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
import { app } from 'electron';
import { limitAsync } from 'es-toolkit/array';
import type { IDjvuConversionPageMetrics } from '@contracts/djvuConversionPolicy';
import {
    renderDjvuPageToImage,
    runRegisteredDjvuProcess,
} from '@electron/features/djvu/main/ddjvuConversion';
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
    kind: 'fallback' | 'layered';
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
}

const logger = createLogger('djvu-compact-pdf');
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRESS_EXTRACTION_CAP = 88;
const PROGRESS_COMBINE_CAP = 90;
const DEFAULT_DPI = 300;
const FOREGROUND_COLOR_RATIO_FALLBACK = 0.01;
const FOREGROUND_COLOR_TOTAL_RATIO_FALLBACK = 0.001;
const FOREGROUND_DARK_RATIO_FALLBACK = 0.18;
const FOREGROUND_NON_WHITE_RATIO_FALLBACK = 0.48;
const FOREGROUND_DARK_RUN_RATIO_FALLBACK = 0.55;
const FOREGROUND_DARK_RUN_MIN_DARK_RATIO = 0.04;
const DJVU_COMPACT_MAX_PAGE_WORKERS = readBoundedIntegerEnv(
    'EVB_DJVU_COMPACT_MAX_PAGE_WORKERS',
    2,
    1,
    4,
);
const DJVU_COMPACT_PROBE_SUBSAMPLE = readBoundedIntegerEnv(
    'EVB_DJVU_COMPACT_PROBE_SUBSAMPLE',
    12,
    2,
    32,
);
const DJVU_COMPACT_BACKGROUND_SUBSAMPLE = readBoundedIntegerEnv(
    'EVB_DJVU_COMPACT_BACKGROUND_SUBSAMPLE',
    6,
    2,
    32,
);
const DJVU_COMPACT_FALLBACK_SUBSAMPLE = readBoundedIntegerEnv(
    'EVB_DJVU_COMPACT_FALLBACK_SUBSAMPLE',
    4,
    2,
    32,
);

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
        const pageSpec = await buildCompactPageSpec(options, pageTempDir, pageNumber);
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
    throwIfAborted(options.signal);

    const layeredCount = pageSpecs.filter(spec => spec.kind === 'layered').length;
    const fallbackCount = pageSpecs.length - layeredCount;
    logger.info(
        `[${options.jobId}] Compact DjVu PDF manifest ready: ${layeredCount} layered, ${fallbackCount} fallback page(s)`,
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

async function buildCompactPageSpec(
    options: ICompactDjvuPdfExportOptions,
    pageTempDir: string,
    pageNumber: number,
): Promise<ICompactPageSpec> {
    const pagePrefix = join(pageTempDir, `page-${String(pageNumber).padStart(5, '0')}-${randomUUID()}`);
    const probePath = `${pagePrefix}-foreground.ppm`;
    const probeResult = await renderDjvuPageToImage(
        options.djvuPath,
        probePath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-probe`,
        {
            format: 'ppm',
            mode: 'foreground',
            subsample: DJVU_COMPACT_PROBE_SUBSAMPLE,
        },
    );
    throwIfCanceledRenderResult(probeResult, options.signal);
    if (!probeResult.success) {
        return buildFallbackPageSpec(options, pagePrefix, pageNumber, `foreground probe failed: ${probeResult.error}`);
    }

    const classification = await classifyPageForLayering(probePath, pageNumber);
    if (!classification.useLayering) {
        return buildFallbackPageSpec(options, pagePrefix, pageNumber, classification.reason);
    }

    const backgroundPath = `${pagePrefix}-background.ppm`;
    const maskPath = `${pagePrefix}-mask.pbm`;
    throwIfAborted(options.signal);
    const backgroundResult = await renderDjvuPageToImage(
        options.djvuPath,
        backgroundPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-background`,
        {
            format: 'ppm',
            mode: 'background',
            subsample: DJVU_COMPACT_BACKGROUND_SUBSAMPLE,
        },
    );
    throwIfCanceledRenderResult(backgroundResult, options.signal);
    if (!backgroundResult.success) {
        return buildFallbackPageSpec(options, pagePrefix, pageNumber, `background extraction failed: ${backgroundResult.error}`);
    }

    throwIfAborted(options.signal);
    const maskResult = await renderDjvuPageToImage(
        options.djvuPath,
        maskPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-mask`,
        {
            format: 'pbm',
            mode: 'mask',
        },
    );
    throwIfCanceledRenderResult(maskResult, options.signal);
    if (!maskResult.success) {
        return buildFallbackPageSpec(options, pagePrefix, pageNumber, `mask extraction failed: ${maskResult.error}`);
    }

    const maskInfo = await readNetpbmInfo(maskPath);
    const pageSize = resolvePageSizePoints(
        options.pageSizes?.[pageNumber - 1] ?? null,
        options.sourceDpi,
        maskInfo,
        1,
    );
    return {
        pageNumber,
        kind: 'layered',
        reason: 'foreground is monochrome text-like content',
        manifestLine: createManifestLine('layered', pageSize, [
            backgroundPath,
            maskPath,
        ]),
    };
}

async function buildFallbackPageSpec(
    options: ICompactDjvuPdfExportOptions,
    pagePrefix: string,
    pageNumber: number,
    reason: string,
): Promise<ICompactPageSpec> {
    throwIfAborted(options.signal);
    const fallbackPath = `${pagePrefix}-fallback.ppm`;
    const result = await renderDjvuPageToImage(
        options.djvuPath,
        fallbackPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-fallback`,
        {
            format: 'ppm',
            subsample: DJVU_COMPACT_FALLBACK_SUBSAMPLE,
        },
    );
    throwIfCanceledRenderResult(result, options.signal);
    if (!result.success) {
        throw new Error(result.error ?? `Failed to render compact fallback page ${pageNumber}`);
    }

    const imageInfo = await readNetpbmInfo(fallbackPath);
    const pageSize = resolvePageSizePoints(
        options.pageSizes?.[pageNumber - 1] ?? null,
        options.sourceDpi,
        imageInfo,
        DJVU_COMPACT_FALLBACK_SUBSAMPLE,
    );
    return {
        pageNumber,
        kind: 'fallback',
        reason,
        manifestLine: createManifestLine('image', pageSize, [fallbackPath]),
    };
}

async function classifyPageForLayering(probePath: string, pageNumber: number) {
    if (pageNumber <= 2) {
        return {
            useLayering: false,
            reason: 'front-matter page rendered as full-page fallback',
        };
    }

    try {
        const stats = await readNetpbmStats(probePath);
        const colorTotalRatio = stats.colorRatio * stats.nonWhiteRatio;
        if (
            stats.colorRatio > FOREGROUND_COLOR_RATIO_FALLBACK
            || colorTotalRatio > FOREGROUND_COLOR_TOTAL_RATIO_FALLBACK
        ) {
            return {
                useLayering: false,
                reason: 'colored foreground probe',
            };
        }
        if (
            stats.darkRatio > FOREGROUND_DARK_RATIO_FALLBACK
            || stats.nonWhiteRatio > FOREGROUND_NON_WHITE_RATIO_FALLBACK
        ) {
            return {
                useLayering: false,
                reason: 'heavy foreground probe',
            };
        }
        if (
            stats.maxDarkRunRatio > FOREGROUND_DARK_RUN_RATIO_FALLBACK
            && stats.darkRatio > FOREGROUND_DARK_RUN_MIN_DARK_RATIO
        ) {
            return {
                useLayering: false,
                reason: 'large continuous dark foreground probe',
            };
        }
        return {
            useLayering: true,
            reason: 'foreground is monochrome text-like content',
        };
    } catch (error) {
        return {
            useLayering: false,
            reason: `foreground probe unreadable: ${getErrorMessage(error)}`,
        };
    }
}

function resolveNativePdfImageCombinePath() {
    const isPackaged = app.isPackaged || __dirname.includes('app.asar');
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
) {
    const dpi = positiveNumber(sourceDpi) ?? DEFAULT_DPI;
    const width = positiveNumber(metrics?.width) ?? renderedInfo.width * renderedSubsample;
    const height = positiveNumber(metrics?.height) ?? renderedInfo.height * renderedSubsample;
    return {
        widthPoints: pointsFromPixels(width, dpi),
        heightPoints: pointsFromPixels(height, dpi),
    };
}

function pointsFromPixels(pixels: number, dpi: number) {
    return Math.max(1, pixels / Math.max(1, dpi) * 72);
}

function positiveNumber(value: number | undefined) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function createManifestLine(
    kind: 'image' | 'layered',
    pageSize: {
        widthPoints: number;
        heightPoints: number;
    },
    paths: string[],
) {
    for (const path of paths) {
        if (!canRepresentManifestPath(path)) {
            throw new Error(`Compact PDF manifest path is not representable: ${path}`);
        }
    }
    return [
        kind,
        pageSize.widthPoints.toFixed(4),
        pageSize.heightPoints.toFixed(4),
        ...paths,
    ].join('\t');
}

function canRepresentManifestPath(path: string) {
    return path.length > 0
        && path.trim() === path
        && !/[\r\n\t]/u.test(path);
}

async function readNetpbmInfo(path: string) {
    return parseNetpbmInfo(await readFile(path));
}

async function readNetpbmStats(path: string) {
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

    if (info.magic === 'P5') {
        for (let y = 0; y < info.height; y += 1) {
            let darkRun = 0;
            for (let x = 0; x < info.width; x += 1) {
                const value = payload[y * info.width + x] ?? 255;
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
    } satisfies INetpbmStats;
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
                emitProgress(PROGRESS_EXTRACTION_CAP + Math.round(
                    (processed / Math.max(1, total)) * (PROGRESS_COMBINE_CAP - PROGRESS_EXTRACTION_CAP),
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
