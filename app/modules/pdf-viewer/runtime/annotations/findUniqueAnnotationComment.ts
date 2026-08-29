import type {IAnnotationCommentSummary} from '@app/types/annotations';

export function findUniqueAnnotationComment(
    comments: readonly IAnnotationCommentSummary[],
    matches: (comment: IAnnotationCommentSummary) => boolean,
) {
    let match: IAnnotationCommentSummary | null = null;
    for (const comment of comments) {
        if (!matches(comment)) {
            continue;
        }
        if (match) {
            return null;
        }
        match = comment;
    }
    return match;
}
