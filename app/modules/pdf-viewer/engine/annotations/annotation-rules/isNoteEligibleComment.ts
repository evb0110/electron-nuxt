import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { isNoteEligible } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isNoteEligible';

export function isNoteEligibleComment(comment: IAnnotationCommentSummary | null | undefined) {
    if (!comment) {
        return false;
    }
    return isNoteEligible(comment.subtype, comment.hasNote, comment.source, comment.text);
}
