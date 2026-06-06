import { isPopupSubtype } from '@app/services/pdf/annotationSubtype';
import type { IPdfAnnotationRecord } from '@app/utils/pdf-viewer/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';

export function buildPopupIndex(
    pageAnnotations: readonly IPdfAnnotationRecord[],
): Map<string, IPdfAnnotationRecord> {
    const popupById = new Map<string, IPdfAnnotationRecord>();
    for (const annotation of pageAnnotations) {
        if (!isPopupSubtype(annotation.subtype) || !annotation.id) {
            continue;
        }
        popupById.set(annotation.id, annotation);
    }
    return popupById;
}
