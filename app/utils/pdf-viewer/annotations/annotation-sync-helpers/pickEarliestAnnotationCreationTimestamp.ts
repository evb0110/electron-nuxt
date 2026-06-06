import { parsePdfDateTimestamp } from '@app/services/pdf/annotationMetadata';
import type { IPdfAnnotationRecord } from '@app/utils/pdf-viewer/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';

export function pickEarliestAnnotationCreationTimestamp(
    annotation: IPdfAnnotationRecord,
    popupAnnotation: IPdfAnnotationRecord | null,
) {
    const own = parsePdfDateTimestamp(annotation.creationDate);
    const popup = popupAnnotation
        ? parsePdfDateTimestamp(popupAnnotation.creationDate)
        : null;
    if (own && popup) {
        return Math.min(own, popup);
    }
    return own ?? popup;
}
