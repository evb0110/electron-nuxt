import type { IPdfNativePageSize } from '@contracts/electronApiDocuments';
import type { TZoomMode } from '@contracts/shared';
import {
    clampDocumentFitScale,
    clampDocumentManualZoom,
} from '@app/utils/document-viewer/zoomPolicy';

interface INativePdfDisplayScaleInput {
    availableHeight: number;
    availableWidth: number;
    manualZoom: number;
    pageSize: IPdfNativePageSize | null | undefined;
    zoomMode: TZoomMode;
}

export function resolveNativePdfDisplayScale(input: INativePdfDisplayScaleInput) {
    const manualZoom = clampDocumentManualZoom(input.manualZoom);
    if (!input.pageSize) {
        return manualZoom;
    }
    if (input.zoomMode === 'fit-width' && input.pageSize.width > 0) {
        return clampDocumentFitScale(input.availableWidth / input.pageSize.width);
    }
    if (input.zoomMode === 'fit-height' && input.pageSize.height > 0) {
        return clampDocumentFitScale(input.availableHeight / input.pageSize.height);
    }
    return manualZoom;
}
