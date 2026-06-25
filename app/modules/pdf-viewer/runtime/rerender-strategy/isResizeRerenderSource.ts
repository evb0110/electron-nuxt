import { isResizePdfRerenderSource } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';

export function isResizeRerenderSource(source: string) {
    return isResizePdfRerenderSource(source);
}
