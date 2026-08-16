import type {
    IScanCleanupRasterRenderLimits,
    TScanCleanupLog,
    TScanCleanupRenderPage,
    TScanCleanupRunCommand,
} from '@scan-cleanup-core/types';
import {
    SCAN_CLEANUP_MAX_BILEVEL_PIXELS,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
} from '@scan-cleanup-core/policy/effectiveOptions';

const PDFTOPPM_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_RASTER_LIMITS = {
    maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
    maxPixels: SCAN_CLEANUP_MAX_BILEVEL_PIXELS,
};

function validateRenderLimits(limits: IScanCleanupRasterRenderLimits | undefined) {
    if (limits === undefined) {
        return;
    }
    for (const [
        label,
        value,
    ] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new TypeError(`Poppler raster ${label} must be a positive safe integer`);
        }
    }
    if (
        limits.expectedWidthPx > limits.maxDimensionPx
        || limits.expectedHeightPx > limits.maxDimensionPx
        || limits.expectedWidthPx * limits.expectedHeightPx > limits.maxPixels
    ) {
        throw new RangeError(
            `Poppler raster ${String(limits.expectedWidthPx)}x${String(limits.expectedHeightPx)} exceeds limits`,
        );
    }
}

function validateCrop(crop: Parameters<TScanCleanupRenderPage>[8]) {
    if (crop === undefined) {
        return;
    }
    for (const field of [
        'x',
        'y',
        'width',
        'height',
    ] as const) {
        const value = crop[field];
        const minimum = field === 'x' || field === 'y' ? 0 : 1;
        if (!Number.isSafeInteger(value) || value < minimum) {
            throw new TypeError(
                `Poppler pixel crop ${field} must be a ${minimum === 0 ? 'non-negative' : 'positive'} safe integer`,
            );
        }
    }
}

async function renderPage(
    runCommand: TScanCleanupRunCommand,
    format: 'png' | 'ppm',
    paths: Pick<Parameters<TScanCleanupRenderPage>[0], 'pdftoppmBinary'>,
    log: TScanCleanupLog,
    pageNumber: number,
    sourcePdfPath: string,
    outputPath: string,
    dpi: number,
    popplerEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    crop?: Parameters<TScanCleanupRenderPage>[8],
    limits?: Parameters<TScanCleanupRenderPage>[9],
) {
    validateCrop(crop);
    validateRenderLimits(limits);
    const commandArgs = [
        ...(format === 'png' ? ['-png'] : []),
        '-cropbox',
        ...(limits?.scaleToFitPx === undefined ? [] : [
            '-scale-to',
            String(limits.scaleToFitPx),
        ]),
        '-r',
        String(dpi),
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-singlefile',
    ];
    if (crop !== undefined) {
        commandArgs.push(
            '-x',
            String(crop.x),
            '-y',
            String(crop.y),
            '-W',
            String(crop.width),
            '-H',
            String(crop.height),
        );
    }
    commandArgs.push(
        sourcePdfPath,
        outputPath.replace(format === 'png' ? /\.png$/u : /\.ppm$/u, ''),
    );
    await runCommand(paths.pdftoppmBinary, commandArgs, {
        commandLabel: `pdftoppm(page=${String(pageNumber)},dpi=${String(dpi)})`,
        timeoutMs: PDFTOPPM_TIMEOUT_MS,
        ...(popplerEnv === undefined ? {} : {env: popplerEnv}),
        ...(signal === undefined ? {} : {signal}),
        log,
    });
}

export function createScanCleanupRenderers(
    runCommand: TScanCleanupRunCommand,
    _fallbackLimits: Pick<IScanCleanupRasterRenderLimits, 'maxDimensionPx' | 'maxPixels'> = DEFAULT_RASTER_LIMITS,
) {
    const renderPageToPng: TScanCleanupRenderPage = async (
        paths,
        log,
        pageNumber,
        sourcePdfPath,
        outputPngPath,
        dpi,
        popplerEnv,
        signal,
        crop,
        limits,
    ) => renderPage(
        runCommand,
        'png',
        paths,
        log,
        pageNumber,
        sourcePdfPath,
        outputPngPath,
        dpi,
        popplerEnv,
        signal,
        crop,
        limits,
    );
    const renderPageToPpm: TScanCleanupRenderPage = (
        paths,
        log,
        pageNumber,
        sourcePdfPath,
        outputPpmPath,
        dpi,
        popplerEnv,
        signal,
        crop,
        limits,
    ) => renderPage(
        runCommand,
        'ppm',
        paths,
        log,
        pageNumber,
        sourcePdfPath,
        outputPpmPath,
        dpi,
        popplerEnv,
        signal,
        crop,
        limits,
    );
    return {
        renderPage: renderPageToPng,
        renderPagePpm: renderPageToPpm,
    };
}
