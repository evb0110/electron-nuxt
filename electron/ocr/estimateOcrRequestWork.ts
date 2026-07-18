import type { IOcrSearchablePdfOptions } from '@contracts/electronApiOcr';
import type { IOcrPdfPageRequest } from '@electron/ocr/worker/types';
import { getOcrConcurrency } from '@electron/utils/concurrency';

function estimateRenderedBytesForPage(renderDpi: number) {
    const widthPx = Math.ceil(8.5 * renderDpi);
    const heightPx = Math.ceil(11 * renderDpi);
    return widthPx * heightPx * 4;
}

export function estimateOcrRequestWork(
    pages: IOcrPdfPageRequest[],
    options: IOcrSearchablePdfOptions,
) {
    const renderDpi = options.renderDpi ?? 300;
    const perPageBytes = estimateRenderedBytesForPage(renderDpi);
    const baselinePageBytes = estimateRenderedBytesForPage(300);
    const pageWeight = Math.max(1, Math.ceil(perPageBytes / baselinePageBytes));
    const peakRenderedPageCount = getOcrConcurrency(pages.length);
    const totalPageWork = pages.length * pageWeight;
    return {
        bytes: peakRenderedPageCount * perPageBytes,
        // Admission must see the true amount of requested work. Clamping here
        // turns a request above the configured cap into one that appears to fit
        // it exactly, allowing multi-thousand-page jobs into the bounded queue.
        pageWork: totalPageWork,
    };
}
