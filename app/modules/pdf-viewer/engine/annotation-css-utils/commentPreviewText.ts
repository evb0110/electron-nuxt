import type { IAnnotationCommentSummary } from '@app/types/annotations';

export function commentPreviewText(comment: IAnnotationCommentSummary, emptyNoteLabel: string) {
    const raw = comment.text.trim();
    if (!raw) {
        return emptyNoteLabel;
    }
    if (raw.length > 120) {
        return `${raw.slice(0, 117)}...`;
    }
    return raw;
}
