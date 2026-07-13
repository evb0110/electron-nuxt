import type { IPdfPageMetric } from '@app/types/pdfUi';

export function buildTrustedPdfGeometrySeed(input: {
    pageNumber: number;
    pageCount: number;
    width: number;
    height: number;
}) {
    if (
        !Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1
        || !Number.isSafeInteger(input.pageCount) || input.pageCount < input.pageNumber
        || !Number.isFinite(input.width) || input.width <= 0
        || !Number.isFinite(input.height) || input.height <= 0
    ) {
        return null;
    }
    return {
        numPages: input.pageCount,
        basePageWidth: input.width,
        basePageHeight: input.height,
        // Deliberately empty: fallback dimensions stage the shell, while every
        // page remains a cache miss and is replaced by authoritative PDF.js metrics.
        pageMetrics: [] as IPdfPageMetric[],
    };
}
