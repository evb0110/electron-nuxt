import { randomUUID } from 'crypto';
import {
    mkdtemp,
    readFile,
    rm,
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
import {
    buildDjvuRuntimeEnv,
    getDjvuToolPaths,
} from '@electron/djvu/paths';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import { convertDjvuPageToImage } from '@electron/features/djvu/main/ddjvuConversion';

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

export async function getDjvuPageSizesForViewing(djvuPath: string, expectedPageCount: number): Promise<IDjvuPageSize[]> {
    const dpi = await getDjvuResolution(djvuPath);
    const { djvused } = getDjvuToolPaths();
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
    });
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
): Promise<IDjvuPagePreview> {
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error(`Invalid DjVu page number: ${pageNumber}`);
    }
    const subsample = normalizePreviewSubsample(options);

    const tempDir = await mkdtemp(join(tmpdir(), 'djvu-preview-'));
    const ppmPath = join(tempDir, `page-${pageNumber}-${randomUUID()}.ppm`);

    try {
        const result = await convertDjvuPageToImage(
            djvuPath,
            ppmPath,
            pageNumber,
            `djvu-preview-page-${pageNumber}-${randomUUID()}`,
            {
                format: 'ppm',
                ...(subsample && subsample > 1 ? { subsample } : {}),
            },
        );
        if (!result.success) {
            throw new Error(result.error ?? `Failed to render DjVu page ${pageNumber}`);
        }

        const ppmBytes = await readFile(ppmPath);
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
