import type { IPageRange } from '@app/types/pdf';
import { shouldPreserveExistingPdfRerenderContent } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';

export function shouldPreserveExistingRerenderContent(options: {
    source: string;
    visibleRange: IPageRange;
    isPageRendered: (page: number) => boolean;
}) {
    return shouldPreserveExistingPdfRerenderContent(options.source);
}
