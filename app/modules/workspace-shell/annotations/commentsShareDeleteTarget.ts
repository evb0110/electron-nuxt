import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { isNoteEligibleComment } from '@app/utils/pdf-viewer/annotations/annotation-rules/isNoteEligibleComment';
import { markerRectCenterDistance } from '@app/utils/pdf-viewer/annotations/annotation-rules/markerRectCenterDistance';

const INVISIBLE_NOTE_PLACEHOLDER_RE = /[\u200B\uFEFF]/gu;

function normalizeNoteText(text: string) {
    return text.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim();
}

export function commentsShareDeleteTarget(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
    isSameAnnotationComment: (a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) => boolean,
) {
    if (left.stableKey && left.stableKey === right.stableKey) {
        return true;
    }
    if (isSameAnnotationComment(left, right)) {
        return true;
    }
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }
    if (left.annotationId && left.annotationId === right.annotationId) {
        return true;
    }
    if (left.uid && left.uid === right.uid) {
        return true;
    }
    if (left.id && left.id === right.id && left.source === right.source) {
        return true;
    }
    if (!isNoteEligibleComment(left) || !isNoteEligibleComment(right)) {
        return false;
    }

    const leftText = normalizeNoteText(left.text);
    const rightText = normalizeNoteText(right.text);
    const sameText = leftText.length > 0 && leftText === rightText;
    const closePlacement = markerRectCenterDistance(left.markerRect, right.markerRect) < 0.035;
    const oneHasStableEditorRef = Boolean(left.annotationId || left.uid) !== Boolean(right.annotationId || right.uid);
    return (
        sameText && (closePlacement || oneHasStableEditorRef)
    ) || (
        closePlacement && oneHasStableEditorRef
    );
}
