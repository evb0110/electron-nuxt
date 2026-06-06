import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { isAnnotationMarkerRect } from '@app/utils/pdf-viewer/serialization/pdf-serialization-shared/isAnnotationMarkerRect';

const POINT_NOTE_MARKER_SIZE = 0.0016;

const MAX_FREETEXT_NOTE_MARKER_SIZE = 0.02;

export function toFreeTextNoteMarkerRect(
    value: IAnnotationCommentSummary['markerRect'],
): IAnnotationMarkerRect | null {
    if (!isAnnotationMarkerRect(value)) {
        return null;
    }

    if (
        value.width <= MAX_FREETEXT_NOTE_MARKER_SIZE
        && value.height <= MAX_FREETEXT_NOTE_MARKER_SIZE
    ) {
        return value;
    }

    return {
        left: value.left,
        top: value.top,
        width: POINT_NOTE_MARKER_SIZE,
        height: POINT_NOTE_MARKER_SIZE,
    };
}
