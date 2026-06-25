import type { IAnnotationCommentSummary } from '@app/types/annotations';

export interface IComputeSummaryStableKeyParams {
    pageIndex: number;
    id: string;
    source: IAnnotationCommentSummary['source'];
    uid?: string | null;
    annotationId?: string | null;
    annotationName?: string | null | undefined;
}

export type TComputeSummaryStableKey = (params: IComputeSummaryStableKeyParams) => string;

export function computeSummaryStableKey(params: IComputeSummaryStableKeyParams) {
    const annotationName = params.annotationName?.trim();
    if (annotationName) {
        return `nm:${annotationName}`;
    }
    if (params.annotationId) {
        return `ann:${params.pageIndex}:${params.annotationId}`;
    }
    if (params.uid) {
        return `uid:${params.pageIndex}:${params.uid}`;
    }
    return `src:${params.source}:${params.pageIndex}:${params.id}`;
}
