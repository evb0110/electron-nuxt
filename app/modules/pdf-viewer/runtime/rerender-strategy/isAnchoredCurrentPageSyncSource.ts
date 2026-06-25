import { isAnchoredCurrentPageSyncPdfRerenderSource } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';

export function isAnchoredCurrentPageSyncSource(source: string) {
    return isAnchoredCurrentPageSyncPdfRerenderSource(source);
}
