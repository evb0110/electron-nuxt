import { randomUUID } from 'crypto';
import {
    mkdtemp,
    readFile,
    rm,
    stat,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { encode } from 'fast-png';
import type {
    IDjvuPagePreview,
    IDjvuPagePreviewOptions,
    IDjvuPageSize,
} from '@contracts/electronApiDjvu';
import { getDjvuResolution } from '@electron/djvu/metadata';
import { parseNetpbm } from '@electron/djvu/netpbm';
import { buildDjvuRuntimeEnv } from '@electron/djvu/paths';
import { getDjvuNativeToolPaths } from '@electron/djvu/nativeToolPaths';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import { convertDjvuPageToImage } from '@electron/features/djvu/main/ddjvuConversion';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';

const DJVU_PAGE_SIZE_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_PAGE_SIZE_TIMEOUT_MS ?? '30000', 10);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        return 30_000;
    }
    return parsed;
})();
const DJVU_PAGE_SIZE_MAX_STDOUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_PAGE_SIZE_MAX_STDOUT_BYTES ?? '1048576', 10);
    if (!Number.isFinite(parsed) || parsed < 16_384) {
        return 1_048_576;
    }
    return parsed;
})();
const DJVU_PREVIEW_SUBSAMPLE_MAX = 12;
const DJVU_PREVIEW_MAX_PIXELS = parseIntegerEnv(
    'EVB_DJVU_PREVIEW_MAX_PIXELS',
    45_000_000,
    1_000_000,
    500_000_000,
);
const DJVU_PREVIEW_MAX_NETPBM_BYTES = parseIntegerEnv(
    'EVB_DJVU_PREVIEW_MAX_NETPBM_MB',
    192,
    1,
    1024,
) * 1024 * 1024;

function parsePositiveInteger(value: string | undefined) {
    if (!value) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizePreviewSubsample(options: IDjvuPagePreviewOptions | undefined) {
    const subsample = options?.subsample;
    if (subsample === undefined) {
        return undefined;
    }
    if (
        !Number.isFinite(subsample)
        || !Number.isInteger(subsample)
        || subsample < 1
        || subsample > DJVU_PREVIEW_SUBSAMPLE_MAX
    ) {
        throw new Error(`Invalid DjVu preview subsample value (expected 1-${DJVU_PREVIEW_SUBSAMPLE_MAX})`);
    }
    return subsample;
}

function normalizePreviewTargetWidth(options: IDjvuPagePreviewOptions | undefined) {
    const targetWidthPx = options?.targetWidthPx;
    if (targetWidthPx === undefined) {
        return undefined;
    }
    if (
        !Number.isFinite(targetWidthPx)
        || !Number.isInteger(targetWidthPx)
        || targetWidthPx < 1
    ) {
        throw new Error('Invalid DjVu preview target width value (expected a positive integer)');
    }
    return targetWidthPx;
}

function getMinimumPreviewSubsample(pageSize: Omit<IDjvuPageSize, 'dpi'> | null) {
    if (!pageSize) {
        return 1;
    }
    if (pageSize.width <= 0 || pageSize.height <= 0) {
        return 1;
    }
    const pixels = pageSize.width * pageSize.height;
    if (!Number.isFinite(pixels) || pixels <= DJVU_PREVIEW_MAX_PIXELS) {
        return 1;
    }
    return Math.min(
        DJVU_PREVIEW_SUBSAMPLE_MAX,
        Math.max(1, Math.ceil(Math.sqrt(pixels / DJVU_PREVIEW_MAX_PIXELS))),
    );
}

interface IDjvuPreviewRenderPlan {
    subsample: number;
    targetHeightPx?: number;
    targetWidthPx?: number;
}

function clampPreviewTargetWidth(
    requestedTargetWidth: number,
    pageSize: Omit<IDjvuPageSize, 'dpi'>,
    subsample: number,
) {
    const renderedNativeWidth = Math.max(1, Math.round(pageSize.width / subsample));
    if (requestedTargetWidth <= renderedNativeWidth) {
        return undefined;
    }

    // ddjvu's over-native `-size` path softens text on low-resolution scans.
    // Keep the native raster at source resolution and let the viewer scale it.
    return undefined;
}

async function resolvePreviewRenderPlan(
    djvuPath: string,
    pageNumber: number,
    options: IDjvuPagePreviewOptions | undefined,
    lifecycleOptions: IDjvuPagePreviewLifecycleOptions,
): Promise<IDjvuPreviewRenderPlan> {
    const requestedSubsample = normalizePreviewSubsample(options) ?? 1;
    const requestedTargetWidth = normalizePreviewTargetWidth(options);
    const pageSize = await readDjvuPageSizeForPreview(djvuPath, pageNumber, lifecycleOptions).catch(() => null);
    const subsample = Math.max(requestedSubsample, getMinimumPreviewSubsample(pageSize));
    if (!pageSize || requestedTargetWidth === undefined) {
        return { subsample };
    }

    const targetWidthPx = clampPreviewTargetWidth(requestedTargetWidth, pageSize, subsample);
    if (targetWidthPx === undefined) {
        return { subsample };
    }

    return {
        subsample,
        targetHeightPx: Math.max(1, Math.round(targetWidthPx * pageSize.height / pageSize.width)),
        targetWidthPx,
    };
}

async function assertPreviewNetpbmReadSafe(ppmPath: string) {
    const ppmStat = await stat(ppmPath);
    if (!ppmStat.isFile()) {
        throw new Error(`DjVu preview output is not a regular file: ${ppmPath}`);
    }
    if (ppmStat.size > DJVU_PREVIEW_MAX_NETPBM_BYTES) {
        const maxMb = Math.floor(DJVU_PREVIEW_MAX_NETPBM_BYTES / (1024 * 1024));
        throw new Error(`DjVu preview output exceeds safe read limit (${maxMb}MB): ${ppmPath}`);
    }
}

function parseSizeLine(line: string): Omit<IDjvuPageSize, 'dpi'> | null {
    const attributeMatch = line.match(/\bwidth=(\d+)\b.*\bheight=(\d+)\b/iu);
    const pairMatch = attributeMatch ?? line.match(/\b(\d+)\s*x\s*(\d+)\b/iu) ?? line.match(/^\s*(\d+)\s+(\d+)\s*$/u);
    const width = parsePositiveInteger(pairMatch?.[1]);
    const height = parsePositiveInteger(pairMatch?.[2]);
    if (width === null || height === null) {
        return null;
    }
    return {
        width,
        height,
    };
}

export function parseDjvuPageSizeOutput(stdout: string, dpi: number): IDjvuPageSize[] {
    return stdout
        .split(/\r?\n/u)
        .flatMap((line) => {
            const size = parseSizeLine(line);
            return size ? [size] : [];
        })
        .map(size => ({
            ...size,
            dpi,
        }));
}

interface IDjvuPagePreviewLifecycleOptions {
    cancelGroup?: string;
    signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted');
    }
}

async function readDjvuPageSizeForPreview(
    djvuPath: string,
    pageNumber: number,
    options: IDjvuPagePreviewLifecycleOptions = {},
) {
    throwIfAborted(options.signal);
    const dpi = await getDjvuResolution(djvuPath, options.signal ? { signal: options.signal } : {});
    throwIfAborted(options.signal);
    const { djvused } = getDjvuNativeToolPaths();
    const result = await runNativeCommand(djvused, [
        djvuPath,
        '-e',
        `select ${pageNumber}; size`,
    ], {
        env: buildDjvuRuntimeEnv(),
        timeoutMs: DJVU_PAGE_SIZE_TIMEOUT_MS,
        maxStdoutBytes: DJVU_PAGE_SIZE_MAX_STDOUT_BYTES,
        commandLabel: 'djvused(page-size)',
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
        rejectOnStdoutTruncation: true,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
    });
    throwIfAborted(options.signal);
    return parseDjvuPageSizeOutput(result.stdout, dpi)[0] ?? null;
}

export async function getDjvuPageSizesForViewing(
    djvuPath: string,
    expectedPageCount: number,
    options: IDjvuPagePreviewLifecycleOptions = {},
): Promise<IDjvuPageSize[]> {
    throwIfAborted(options.signal);
    const dpi = await getDjvuResolution(djvuPath, options.signal ? { signal: options.signal } : {});
    throwIfAborted(options.signal);
    const { djvused } = getDjvuNativeToolPaths();
    const result = await runNativeCommand(djvused, [
        djvuPath,
        '-e',
        'select; size',
    ], {
        env: buildDjvuRuntimeEnv(),
        timeoutMs: DJVU_PAGE_SIZE_TIMEOUT_MS,
        maxStdoutBytes: DJVU_PAGE_SIZE_MAX_STDOUT_BYTES,
        commandLabel: 'djvused(size)',
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
        rejectOnStdoutTruncation: true,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
    });
    throwIfAborted(options.signal);
    const sizes = parseDjvuPageSizeOutput(result.stdout, dpi);
    if (sizes.length !== expectedPageCount) {
        throw new Error(`DjVu page size probe returned ${sizes.length} page(s), expected ${expectedPageCount}`);
    }
    return sizes;
}

export async function renderDjvuPagePreview(
    djvuPath: string,
    pageNumber: number,
    options?: IDjvuPagePreviewOptions,
    lifecycleOptions: IDjvuPagePreviewLifecycleOptions = {},
): Promise<IDjvuPagePreview> {
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error(`Invalid DjVu page number: ${pageNumber}`);
    }
    const renderPlan = await resolvePreviewRenderPlan(djvuPath, pageNumber, options, lifecycleOptions);

    const tempDir = await mkdtemp(join(tmpdir(), 'djvu-preview-'));
    const ppmPath = join(tempDir, `page-${pageNumber}-${randomUUID()}.ppm`);

    try {
        throwIfAborted(lifecycleOptions.signal);
        const processId = lifecycleOptions.cancelGroup ?? `djvu-preview-page-${pageNumber}-${randomUUID()}`;
        const result = await convertDjvuPageToImage(
            djvuPath,
            ppmPath,
            pageNumber,
            processId,
            {
                format: 'ppm',
                ...(renderPlan.subsample > 1 ? { subsample: renderPlan.subsample } : {}),
                ...(renderPlan.targetWidthPx && renderPlan.targetHeightPx
                    ? {
                        targetHeightPx: renderPlan.targetHeightPx,
                        targetWidthPx: renderPlan.targetWidthPx,
                    }
                    : {}),
                ...(lifecycleOptions.signal ? { signal: lifecycleOptions.signal } : {}),
            },
        );
        throwIfAborted(lifecycleOptions.signal);
        if (!result.success) {
            throw new Error(result.error ?? `Failed to render DjVu page ${pageNumber}`);
        }

        await assertPreviewNetpbmReadSafe(ppmPath);
        throwIfAborted(lifecycleOptions.signal);
        const ppmBytes = await readFile(ppmPath);
        throwIfAborted(lifecycleOptions.signal);
        const {
            width,
            height,
            channels,
            pixels,
        } = parseNetpbm(ppmBytes);
        const pngBytes = encode({
            width,
            height,
            data: pixels,
            channels,
        });
        return {
            bytes: pngBytes,
            width,
            height,
        };
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}
