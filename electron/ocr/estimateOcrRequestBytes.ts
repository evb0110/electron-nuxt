import type { IOcrSearchablePdfOptions } from '@contracts/electronApiOcr';
import type { IOcrPdfPageRequest } from '@electron/ocr/worker/types';
import { getOcrConcurrency } from '@electron/utils/concurrency';

const DEFAULT_PAGE_WIDTH_IN = 8.5;
const DEFAULT_PAGE_HEIGHT_IN = 11;
const BYTES_PER_RGBA_PIXEL = 4;

export function estimateOcrRequestBytes(
    pages: IOcrPdfPageRequest[],
    options: IOcrSearchablePdfOptions,
) {
    const renderDpi = options.renderDpi ?? 300;
    const perPageBytes = Math.ceil(DEFAULT_PAGE_WIDTH_IN * renderDpi)
        * Math.ceil(DEFAULT_PAGE_HEIGHT_IN * renderDpi)
        * BYTES_PER_RGBA_PIXEL;
    return getOcrConcurrency(pages.length) * perPageBytes;
}
