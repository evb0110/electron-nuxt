import type { IDjvuConvertOptions } from '@contracts/electronApiDjvu';
import {
    normalizeDjvuPdfSubsample,
    resolveDjvuPdfExportStrategy,
} from '@contracts/djvuConversionPolicy';

const MAX_PAGES = 500;
const MAX_PAGE_PIXELS = 80_000_000;
const DEFAULT_MAX_PAGE_SPEC_BYTES = 192 * 1024 * 1024;
const PAGE_SPEC_OVERHEAD_BYTES = 256;
const PHOTO_PPI_CAP = 300;
const DIRECT_PDF_JPEG_QUALITY = 0.92;
const COMPACT_PHOTO_PDF_JPEG_QUALITY = 85;
const WORKER_COPY_BUDGET_BYTES = 192 * 1024 * 1024;
const PDF_RENDER_WORKER_LIMIT = 3;
const PDF_MEDIUM_PAGE_PIXEL_COUNT = 16_000_000;
const PDF_LARGE_PAGE_PIXEL_COUNT = 32_000_000;

export interface IBrowserDjvuPdfRenderSettings {
    strategy: 'direct' | 'compact-djvu-aware';
    subsample: number;
    jpegQuality: number;
}

export function resolveBrowserDjvuPdfRenderSettings(
    options: Pick<IDjvuConvertOptions, 'pdfStrategy' | 'subsample'>,
): IBrowserDjvuPdfRenderSettings {
    const strategy = resolveDjvuPdfExportStrategy(options.pdfStrategy);
    const requestedSubsample = normalizeDjvuPdfSubsample(options.subsample);
    return {
        strategy,
        subsample: requestedSubsample,
        jpegQuality: strategy === 'compact-djvu-aware'
            ? COMPACT_PHOTO_PDF_JPEG_QUALITY
            : DIRECT_PDF_JPEG_QUALITY,
    };
}

export function resolveBrowserDjvuPdfRenderConcurrency(
    pageSizes: ReadonlyArray<Pick<IBrowserDjvuPageMetrics, 'width' | 'height'>>,
    hardwareConcurrency = typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency,
    sourceBytes = 0,
) {
    const pageCount = Math.max(1, pageSizes.length);
    const normalizedHardwareConcurrency = typeof hardwareConcurrency === 'number'
        && Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
        ? Math.trunc(hardwareConcurrency)
        : 2;
    const hardwareWorkerCount = Math.max(1, Math.floor(normalizedHardwareConcurrency / 2));
    const maxPagePixels = pageSizes.reduce((maxPixels, size) => {
        const width = typeof size.width === 'number' && Number.isFinite(size.width)
            ? Math.max(0, Math.trunc(size.width))
            : 0;
        const height = typeof size.height === 'number' && Number.isFinite(size.height)
            ? Math.max(0, Math.trunc(size.height))
            : 0;
        return Math.max(maxPixels, width * height);
    }, 0);
    const pixelWorkerLimit = maxPagePixels >= PDF_LARGE_PAGE_PIXEL_COUNT
        ? 1
        : maxPagePixels >= PDF_MEDIUM_PAGE_PIXEL_COUNT
            ? 2
            : PDF_RENDER_WORKER_LIMIT;
    const sourceCopyLimit = sourceBytes > 0
        ? Math.max(1, Math.floor(WORKER_COPY_BUDGET_BYTES / sourceBytes))
        : PDF_RENDER_WORKER_LIMIT;
    return Math.min(pageCount, PDF_RENDER_WORKER_LIMIT, pixelWorkerLimit, sourceCopyLimit, hardwareWorkerCount);
}

export interface IBrowserDjvuPageMetrics {
    width?: number;
    height?: number;
    dpi: number;
}

export interface IBrowserDjvuConversionPreflight {
    allowed: boolean;
    maxPagePixels: number;
    maxPages: number;
    observedMaxPagePixels: number;
    pageCount: number;
    reason?: 'page-count' | 'page-pixels';
}

export interface IBrowserDjvuCompactExportPlan {
    strategy: 'compact-djvu-aware' | 'direct-fallback';
    estimatedPageSpecBytes: number;
    maxPageSpecBytes: number;
    fallbackReason?: 'bookmarks' | 'memory-budget';
}

function positiveInteger(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

function estimatePageSpecBytes(pageSizes: readonly IBrowserDjvuPageMetrics[]) {
    return pageSizes.reduce((totalBytes, page) => {
        const width = positiveInteger(page.width) ?? 1;
        const height = positiveInteger(page.height) ?? 1;
        const dpi = positiveInteger(page.dpi) ?? PHOTO_PPI_CAP;
        const scale = Math.max(1, dpi / PHOTO_PPI_CAP);
        return totalBytes + PAGE_SPEC_OVERHEAD_BYTES
            + Math.max(1, Math.round(width / scale)) * Math.max(1, Math.round(height / scale)) * 3;
    }, 0);
}

export function resolveBrowserDjvuCompactExportPlan(
    pageSizes: readonly IBrowserDjvuPageMetrics[],
    maxPageSpecBytes = DEFAULT_MAX_PAGE_SPEC_BYTES,
    preserveBookmarks = false,
): IBrowserDjvuCompactExportPlan {
    const estimatedPageSpecBytes = estimatePageSpecBytes(pageSizes);
    const fallbackReason = preserveBookmarks
        ? 'bookmarks'
        : estimatedPageSpecBytes > maxPageSpecBytes
            ? 'memory-budget'
            : undefined;
    return {
        strategy: fallbackReason ? 'direct-fallback' : 'compact-djvu-aware',
        estimatedPageSpecBytes,
        maxPageSpecBytes,
        ...(fallbackReason ? {fallbackReason} : {}),
    };
}

export function resolveBrowserDjvuConversionPreflight(
    pageSizes: readonly IBrowserDjvuPageMetrics[],
): IBrowserDjvuConversionPreflight {
    const observedMaxPagePixels = pageSizes.reduce((maxPixels, page) => {
        const width = Number.isFinite(page.width) ? Math.max(0, Math.trunc(page.width ?? 0)) : 0;
        const height = Number.isFinite(page.height) ? Math.max(0, Math.trunc(page.height ?? 0)) : 0;
        return Math.max(maxPixels, width * height);
    }, 0);
    const reason = pageSizes.length > MAX_PAGES
        ? 'page-count'
        : observedMaxPagePixels > MAX_PAGE_PIXELS
            ? 'page-pixels'
            : undefined;
    return {
        allowed: reason === undefined,
        maxPagePixels: MAX_PAGE_PIXELS,
        maxPages: MAX_PAGES,
        observedMaxPagePixels,
        pageCount: pageSizes.length,
        ...(reason ? {reason} : {}),
    };
}
