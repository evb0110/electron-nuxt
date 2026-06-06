import type { IAnnotationCommentSummary } from '@app/types/annotations';

export interface IAnnotationDeleteResolverIdentity {
    resolveCommentFromCache: (comment: IAnnotationCommentSummary) => IAnnotationCommentSummary | null;
    commentMergePriority: (comment: IAnnotationCommentSummary) => number;
}
