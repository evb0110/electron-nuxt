import { join } from 'path';
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import {
    mkdtemp,
    rm,
} from 'fs/promises';
import { convertDjvuPageToImage } from '@electron/djvu/convert';
import { getDjvuResolution } from '@electron/djvu/metadata';
import { buildOptimizedPdf } from '@electron/djvu/pdf-builder';
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';

interface IDjvuSizeEstimate {
    subsample: number;
    label: string;
    description: string;
    resultingDpi: number;
    estimatedBytes: number;
}

const logger = createLogger('djvu-estimate');
const DJVU_ESTIMATE_CACHE_MAX_ENTRIES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_ESTIMATE_CACHE_MAX_ENTRIES ?? '64', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 64;
    }
    return Math.min(parsed, 512);
})();
const DJVU_ESTIMATE_CACHE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_ESTIMATE_CACHE_TTL_MS ?? `${10 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 10 * 60 * 1000;
    }
    return parsed;
})();

type TDjvuEstimateCacheEntry = {
    estimates: IDjvuSizeEstimate[];
    cachedAt: number;
    accessedAt: number;
};

const estimateCache = new Map<string, TDjvuEstimateCacheEntry>();

function pruneEstimateCache(now = Date.now()) {
    for (const [
        cacheKey,
        entry,
    ] of estimateCache.entries()) {
        if (now - entry.cachedAt > DJVU_ESTIMATE_CACHE_TTL_MS) {
            estimateCache.delete(cacheKey);
        }
    }

    if (estimateCache.size <= DJVU_ESTIMATE_CACHE_MAX_ENTRIES) {
        return;
    }

    const sortedByLeastRecentlyUsed = Array.from(estimateCache.entries())
        .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
    const overflowCount = estimateCache.size - DJVU_ESTIMATE_CACHE_MAX_ENTRIES;
    for (let index = 0; index < overflowCount; index += 1) {
        const entry = sortedByLeastRecentlyUsed[index];
        if (!entry) {
            break;
        }
        estimateCache.delete(entry[0]);
    }
}

export async function estimateSizes(
    djvuPath: string,
    pageCount: number,
): Promise<IDjvuSizeEstimate[]> {
    const now = Date.now();
    pruneEstimateCache(now);

    const cached = estimateCache.get(djvuPath);
    if (cached && now - cached.cachedAt <= DJVU_ESTIMATE_CACHE_TTL_MS) {
        cached.accessedAt = now;
        return cached.estimates;
    }
    if (cached) {
        estimateCache.delete(djvuPath);
    }

    const sourceDpi = await getDjvuResolution(djvuPath);

    // Sample a page from the middle third of the document for accurate estimation.
    // First/last pages (covers, end matter) are typically much smaller than content pages.
    const samplePage = Math.max(1, Math.floor(pageCount * 0.33));

    const presets = [
        {
            subsample: 1,
            label: te('djvu.convertDialog.fullQuality'),
            description: te('djvu.convertDialog.original'),
        },
        {
            subsample: 2,
            label: te('djvu.convertDialog.goodQuality'),
            description: te('djvu.convertDialog.halfResolution'),
        },
        {
            subsample: 4,
            label: te('djvu.convertDialog.compact'),
            description: te('djvu.convertDialog.quarterResolution'),
        },
    ];

    const tempDir = await mkdtemp(join(app.getPath('temp'), 'djvu-estimate-'));

    const estimates: IDjvuSizeEstimate[] = [];
    const estimateJobIdPrefix = `estimate-${randomUUID()}`;

    try {
        for (const preset of presets) {
            const imagePath = join(tempDir, `sample-s${preset.subsample}.ppm`);
            const effectiveDpi = Math.round(sourceDpi / preset.subsample);

            try {
                const result = await convertDjvuPageToImage(
                    djvuPath,
                    imagePath,
                    samplePage,
                    `${estimateJobIdPrefix}-${preset.subsample}`,
                    {
                        subsample: preset.subsample > 1 ? preset.subsample : undefined,
                        format: 'ppm',
                    },
                );

                if (result.success) {
                    const pdfBytes = await buildOptimizedPdf([imagePath], effectiveDpi);

                    estimates.push({
                        subsample: preset.subsample,
                        label: preset.label,
                        description: preset.description,
                        resultingDpi: effectiveDpi,
                        estimatedBytes: Math.round(pdfBytes.length * pageCount),
                    });
                } else {
                    estimates.push({
                        subsample: preset.subsample,
                        label: preset.label,
                        description: preset.description,
                        resultingDpi: effectiveDpi,
                        estimatedBytes: 0,
                    });
                }
            } catch (error) {
                logger.debug(`Failed to estimate DjVu size (subsample=${preset.subsample}) for ${djvuPath}: ${String(error)}`);
                estimates.push({
                    subsample: preset.subsample,
                    label: preset.label,
                    description: preset.description,
                    resultingDpi: effectiveDpi,
                    estimatedBytes: 0,
                });
            }
        }
    } finally {
        try {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        } catch (cleanupError) {
            logger.debug(`Failed to cleanup DjVu estimate temp dir ${tempDir}: ${String(cleanupError)}`);
        }
    }

    const cacheTimestamp = Date.now();
    estimateCache.set(djvuPath, {
        estimates,
        cachedAt: cacheTimestamp,
        accessedAt: cacheTimestamp,
    });
    pruneEstimateCache(cacheTimestamp);
    return estimates;
}
