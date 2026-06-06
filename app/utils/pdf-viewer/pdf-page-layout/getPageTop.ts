import type { IPdfPageLayoutMetrics } from '@app/utils/pdf-viewer/pdf-page-layout/pdfPageLayoutMetrics';

export function getPageTop(layout: IPdfPageLayoutMetrics, pageNumber: number) {
    return layout.pageTops[Math.max(0, pageNumber - 1)] ?? null;
}
