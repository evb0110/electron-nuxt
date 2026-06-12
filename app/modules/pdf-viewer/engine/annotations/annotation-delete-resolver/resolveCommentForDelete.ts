import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import type { IAnnotationDeleteResolverIdentity } from '@app/modules/pdf-viewer/engine/annotations/annotation-delete-resolver/annotationDeleteResolverIdentity';
import { findDirectStableRefDeleteTarget } from '@app/modules/pdf-viewer/engine/annotations/annotation-delete-resolver/findDirectStableRefDeleteTarget';
import { findStrictDeleteTarget } from '@app/modules/pdf-viewer/engine/annotations/annotation-delete-resolver/findStrictDeleteTarget';
import { pickScoredDeleteTarget } from '@app/modules/pdf-viewer/engine/annotations/annotation-delete-resolver/pickScoredDeleteTarget';
import { scoreDeleteCandidate } from '@app/modules/pdf-viewer/engine/annotations/annotation-delete-resolver/scoreDeleteCandidate';

interface IResolveCommentForDeleteOptions {
    comment: IAnnotationCommentSummary;
    candidates: IAnnotationCommentSummary[];
    identity: IAnnotationDeleteResolverIdentity;
    findEditorForComment: (comment: IAnnotationCommentSummary) => IPdfjsEditor | null;
}

export function resolveCommentForDelete(options: IResolveCommentForDeleteOptions) {
    const {
        comment,
        candidates,
        identity,
        findEditorForComment,
    } = options;
    const strictResolved = findStrictDeleteTarget(comment, identity, findEditorForComment);
    if (strictResolved) {
        return strictResolved;
    }

    const pageCandidates = candidates.filter(c => c.pageIndex === comment.pageIndex);
    if (pageCandidates.length === 0) {
        return null;
    }

    const targetText = comment.text.trim().toLowerCase();
    const directStableRefMatch = findDirectStableRefDeleteTarget(comment, pageCandidates, targetText, identity);
    if (directStableRefMatch) {
        return directStableRefMatch;
    }

    const targetSubtype = (comment.subtype ?? '').trim().toLowerCase();
    const scored = pageCandidates
        .map(candidate => scoreDeleteCandidate(comment, candidate, targetText, targetSubtype))
        .sort((l, r) => r.score - l.score);

    return pickScoredDeleteTarget(scored);
}
