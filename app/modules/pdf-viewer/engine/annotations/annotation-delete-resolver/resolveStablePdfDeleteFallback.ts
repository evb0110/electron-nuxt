import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IAnnotationDeleteResolverIdentity } from '@app/modules/pdf-viewer/engine/annotations/annotation-delete-resolver/annotationDeleteResolverIdentity';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';

interface IResolveStablePdfDeleteFallbackOptions {
    comment: IAnnotationCommentSummary;
    candidates: IAnnotationCommentSummary[];
    identity: IAnnotationDeleteResolverIdentity;
}

export function resolveStablePdfDeleteFallback(options: IResolveStablePdfDeleteFallbackOptions) {
    const annotationId = annotationIdForSummary(options.comment);
    const exactMatches = options.candidates.filter(candidate => annotationIdForSummary(candidate) === annotationId);
    return exactMatches.length === 1 ? exactMatches[0]! : null;
}
