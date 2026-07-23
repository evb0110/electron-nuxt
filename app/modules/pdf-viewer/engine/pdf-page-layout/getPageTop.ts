import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import { getLayoutPageTop } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

export function getPageTop(layout: IPdfPageLayoutMetrics, pageNumber: number) {
    return getLayoutPageTop(layout, Math.max(0, pageNumber - 1));
}
