export interface IDjvuConversionPageMetrics {
    width: number;
    height: number;
}

export interface IDjvuPdfConversionMetrics {
    pageCount: number;
    sourceDpi: number;
    pageSizes?: readonly IDjvuConversionPageMetrics[] | null;
}

export interface IDjvuPdfConversionPolicyDecision {
    subsample: number;
    recommendedSubsample: number;
    effectivePixels: number;
    pixelLimit: number;
    isAllowed: boolean;
}

export type TDjvuPdfExportStrategy = 'direct' | 'compact-djvu-aware' | 'auto';

export type TDjvuPdfResolvedExportStrategy = 'direct' | 'compact-djvu-aware';

export type TDjvuCompactFidelityPreset = 'small' | 'balanced' | 'archival';

export function resolveDjvuCompactFidelityPreset(subsample: number | undefined): TDjvuCompactFidelityPreset {
    const normalized = normalizeDjvuPdfSubsample(subsample);
    if (normalized >= 4) {
        return 'small';
    }
    if (normalized >= 2) {
        return 'balanced';
    }
    return 'archival';
}

export const DJVU_PDF_CONVERSION_PRESET_SUBSAMPLES = [
    1,
    2,
    4,
] as const;

export const DJVU_PDF_DIRECT_CONVERSION_EFFECTIVE_PIXEL_LIMIT = 8_000_000_000;

const FALLBACK_BOOK_PAGE_AREA_SQUARE_INCHES = 8.5 * 11;
const DEFAULT_DJVU_SOURCE_DPI = 300;

function normalizePositiveInteger(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0
        ? Math.max(1, Math.trunc(value))
        : fallback;
}

export function normalizeDjvuPdfSubsample(value: number | undefined) {
    return normalizePositiveInteger(value ?? 1, 1);
}

export function resolveDjvuPdfExportStrategy(
    strategy: TDjvuPdfExportStrategy | undefined,
): TDjvuPdfResolvedExportStrategy {
    switch (strategy ?? 'direct') {
        case 'auto':
        case 'direct':
            return 'direct';
        case 'compact-djvu-aware':
            return 'compact-djvu-aware';
        default:
            throw new Error('Invalid DjVu PDF export strategy');
    }
}

function estimateSourcePixels(metrics: IDjvuPdfConversionMetrics) {
    const pagePixels = (metrics.pageSizes ?? [])
        .filter(size => Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0)
        .reduce((total, size) => total + (Math.trunc(size.width) * Math.trunc(size.height)), 0);
    if (pagePixels > 0) {
        return pagePixels;
    }

    const pageCount = normalizePositiveInteger(metrics.pageCount, 1);
    const dpi = normalizePositiveInteger(metrics.sourceDpi, DEFAULT_DJVU_SOURCE_DPI);
    return pageCount * dpi * dpi * FALLBACK_BOOK_PAGE_AREA_SQUARE_INCHES;
}

export function estimateDjvuPdfEffectivePixels(
    metrics: IDjvuPdfConversionMetrics,
    subsample: number | undefined,
) {
    const normalizedSubsample = normalizeDjvuPdfSubsample(subsample);
    return Math.ceil(estimateSourcePixels(metrics) / (normalizedSubsample * normalizedSubsample));
}

export function resolveRecommendedDjvuPdfSubsample(
    metrics: IDjvuPdfConversionMetrics,
    allowedSubsamples: readonly number[] = DJVU_PDF_CONVERSION_PRESET_SUBSAMPLES,
) {
    const candidates = allowedSubsamples
        .map(normalizeDjvuPdfSubsample)
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort((left, right) => left - right);
    const candidateSubsamples = candidates.length > 0 ? candidates : [1];

    return candidateSubsamples.find(subsample =>
        estimateDjvuPdfEffectivePixels(metrics, subsample) <= DJVU_PDF_DIRECT_CONVERSION_EFFECTIVE_PIXEL_LIMIT,
    ) ?? candidateSubsamples[candidateSubsamples.length - 1]!;
}

export function evaluateDjvuPdfConversionPolicy(
    metrics: IDjvuPdfConversionMetrics,
    subsample: number | undefined,
): IDjvuPdfConversionPolicyDecision {
    const normalizedSubsample = normalizeDjvuPdfSubsample(subsample);
    const effectivePixels = estimateDjvuPdfEffectivePixels(metrics, normalizedSubsample);
    const recommendedSubsample = resolveRecommendedDjvuPdfSubsample(metrics);

    return {
        subsample: normalizedSubsample,
        recommendedSubsample,
        effectivePixels,
        pixelLimit: DJVU_PDF_DIRECT_CONVERSION_EFFECTIVE_PIXEL_LIMIT,
        isAllowed: normalizedSubsample >= recommendedSubsample
            || effectivePixels <= DJVU_PDF_DIRECT_CONVERSION_EFFECTIVE_PIXEL_LIMIT,
    };
}
