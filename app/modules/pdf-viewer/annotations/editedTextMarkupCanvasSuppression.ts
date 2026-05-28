import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { normalizePdfJsAnnotationId } from '@app/composables/pdf/pdfSerializationRefs';
import { normalizeMarkerRect } from '@app/composables/pdf/annotationGeometry';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';

export function collectEditedTextMarkupCanvasSuppressionIds(
    comments: readonly IAnnotationCommentSummary[],
    baseIds?: Iterable<string>,
) {
    const ids = new Set<string>();
    if (baseIds) {
        for (const id of baseIds) {
            const normalizedId = normalizePdfJsAnnotationId(id);
            if (normalizedId) {
                ids.add(normalizedId);
            }
        }
    }

    for (const comment of comments) {
        if (
            comment.colorEdited !== true
            || !comment.color
            || !normalizeMarkerRect(comment.markerRect)
            || !isTextMarkupSubtype(comment.subtype)
        ) {
            continue;
        }

        const normalizedId = normalizePdfJsAnnotationId(comment.annotationId ?? comment.id);
        if (normalizedId) {
            ids.add(normalizedId);
        }
    }

    return ids;
}
