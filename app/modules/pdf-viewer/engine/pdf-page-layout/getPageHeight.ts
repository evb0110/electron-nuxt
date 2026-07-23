import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import { getLayoutPageHeight } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

export function getPageHeight(layout: IPdfPageLayoutMetrics, pageNumber: number) {
    const pageIndex = Math.max(0, pageNumber - 1);
    return pageIndex < layout.base.pageHeights.length
        ? getLayoutPageHeight(layout, pageIndex)
        : null;
}
