import { getAnnotationCommentText } from '@app/services/pdf/annotationMetadata';
import type { IPdfAnnotationRecord } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';

const NOTE_INVISIBLE_CHAR_REGEX = /[\u200B\uFEFF]/g;

export function resolveCombinedAnnotationText(
    annotation: IPdfAnnotationRecord,
    popupAnnotation: IPdfAnnotationRecord | null,
) {
    const annotationText = getAnnotationCommentText(annotation);
    const popupText = popupAnnotation
        ? getAnnotationCommentText(popupAnnotation)
        : '';
    // Strip ZWS/BOM left by legacy saves so we detect truly-empty /Contents
    // and fall through to the popup text (see docs/freetext-note-persistence.md)
    const visibleAnnotationText = annotationText.replace(NOTE_INVISIBLE_CHAR_REGEX, '').trim();
    if (visibleAnnotationText.length > 0) {
        return annotationText;
    }
    if (popupText.length > 0) {
        return popupText;
    }
    return annotationText;
}
