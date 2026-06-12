import type { ILinkAnnotation } from '@app/types/annotations';
import { toMarkerRectFromPdfRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import { getOptionalString } from '@app/services/pdfjs/runtime';
import type { IPdfAnnotationRecord } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';

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
