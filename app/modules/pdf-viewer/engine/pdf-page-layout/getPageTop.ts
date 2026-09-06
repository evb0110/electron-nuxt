import { pageNumberToPageIndex } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import { getLayoutPageTop } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

export function getPageTop(layout: IPdfPageLayoutMetrics, pageNumber: TPageNumber) {
    return getLayoutPageTop(layout, pageNumberToPageIndex(pageNumber));
}
