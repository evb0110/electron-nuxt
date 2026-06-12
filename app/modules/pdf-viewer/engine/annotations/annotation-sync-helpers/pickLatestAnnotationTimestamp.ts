import { parsePdfDateTimestamp } from '@app/services/pdf/annotationMetadata';
import type { IPdfAnnotationRecord } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';

export function pickLatestAnnotationTimestamp(
    annotation: IPdfAnnotationRecord,
    popupAnnotation: IPdfAnnotationRecord | null,
) {
    const own = parsePdfDateTimestamp(annotation.modificationDate)
        ?? parsePdfDateTimestamp(annotation.creationDate);
    const popup = popupAnnotation
        ? (parsePdfDateTimestamp(popupAnnotation.modificationDate)
            ?? parsePdfDateTimestamp(popupAnnotation.creationDate))
        : null;
    if (own && popup) {
        return Math.max(own, popup);
    }
    return own ?? popup;
}
