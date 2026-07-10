import {
    OCR_QUEUE_MAX_DOCUMENT_PAGE_WORK,
    OCR_QUEUE_MAX_GLOBAL_PAGE_WORK,
} from '@electron/ocr/jobManager.config';
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
        pageWork: Math.min(
            totalPageWork,
            OCR_QUEUE_MAX_DOCUMENT_PAGE_WORK,
            OCR_QUEUE_MAX_GLOBAL_PAGE_WORK,
        ),
    };
}
