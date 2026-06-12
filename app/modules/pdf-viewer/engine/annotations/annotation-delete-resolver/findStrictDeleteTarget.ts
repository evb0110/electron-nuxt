import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import type { IAnnotationDeleteResolverIdentity } from '@app/modules/pdf-viewer/engine/annotations/annotation-delete-resolver/annotationDeleteResolverIdentity';

export function findStrictDeleteTarget(
    comment: IAnnotationCommentSummary,
    identity: IAnnotationDeleteResolverIdentity,
    findEditorForComment: (comment: IAnnotationCommentSummary) => IPdfjsEditor | null,
) {
    const strictResolved = identity.resolveCommentFromCache(comment);
    if (!strictResolved) {
        return null;
    }

    const hasStablePdfRef = Boolean(strictResolved.annotationId);
    const strictEditor = findEditorForComment(strictResolved);
    return hasStablePdfRef || strictEditor ? strictResolved : null;
}
