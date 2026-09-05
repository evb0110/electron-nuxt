import { parsePdfDateTimestamp } from '@app/services/pdf/annotationMetadata';
import { parseEpochMs } from '@contracts/timestamps';
import type { IPdfAnnotationRecord } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';

export function pickLatestAnnotationTimestamp(
    annotation: IPdfAnnotationRecord,
    popupAnnotation: IPdfAnnotationRecord | null,
) {
    const own = parseEpochMs(
        parsePdfDateTimestamp(annotation.modificationDate)
            ?? parsePdfDateTimestamp(annotation.creationDate),
    );
    const popup = popupAnnotation
        ? parseEpochMs(
            parsePdfDateTimestamp(popupAnnotation.modificationDate)
                ?? parsePdfDateTimestamp(popupAnnotation.creationDate),
        )
        : null;
    if (own && popup) {
        return parseEpochMs(Math.max(own, popup));
    }
    return own ?? popup;
}
