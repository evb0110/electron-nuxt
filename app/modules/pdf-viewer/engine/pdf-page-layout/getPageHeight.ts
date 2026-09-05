import { pageNumberToPageIndex } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import { getLayoutPageHeight } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

export function getPageHeight(layout: IPdfPageLayoutMetrics, pageNumber: TPageNumber) {
    const pageIndex = pageNumberToPageIndex(pageNumber);
    return pageIndex < layout.base.pageHeights.length
        ? getLayoutPageHeight(layout, pageIndex)
        : null;
}
