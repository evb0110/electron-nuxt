import type { IPdfPageLayoutMetrics } from '@app/utils/pdf-viewer/pdf-page-layout/pdfPageLayoutMetrics';

export function getPageHeight(layout: IPdfPageLayoutMetrics, pageNumber: number) {
    return layout.pageHeights[Math.max(0, pageNumber - 1)] ?? null;
}
