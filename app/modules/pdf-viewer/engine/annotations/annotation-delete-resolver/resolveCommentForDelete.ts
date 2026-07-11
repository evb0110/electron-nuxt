import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import type { IAnnotationDeleteResolverIdentity } from '@app/modules/pdf-viewer/engine/annotations/annotation-delete-resolver/annotationDeleteResolverIdentity';
import { findStrictDeleteTarget } from '@app/modules/pdf-viewer/engine/annotations/annotation-delete-resolver/findStrictDeleteTarget';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';

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

    const annotationId = annotationIdForSummary(comment);
    const exactMatches = candidates.filter(candidate => annotationIdForSummary(candidate) === annotationId);
    return exactMatches.length === 1 ? exactMatches[0]! : null;
}
