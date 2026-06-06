import type { ILinkAnnotation } from '@app/types/annotations';
import { toMarkerRectFromPdfRect } from '@app/utils/pdf-viewer/annotation-geometry/toMarkerRectFromPdfRect';
import type { TPageRotation } from '@app/utils/pdf-viewer/annotation-geometry/pageRotation';
import { getOptionalString } from '@app/services/pdfjs/runtime';
import type { IPdfAnnotationRecord } from '@app/utils/pdf-viewer/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';

export function tryExtractPdfLinkAnnotation(
    annotation: IPdfAnnotationRecord,
    pageNumber: number,
    annotationIndex: number,
    pageView: number[] | null,
    pageRotation: TPageRotation,
): ILinkAnnotation | null {
    const url = getOptionalString(annotation, 'url');
    if (!url || !annotation.rect) {
        return null;
    }
    const rect = toMarkerRectFromPdfRect(annotation.rect, pageView, pageRotation);
    if (!rect) {
        return null;
    }
    return {
        id: annotation.id ?? `link-${pageNumber}-${annotationIndex}`,
        pageNumber,
        url,
        rect,
    };
}
