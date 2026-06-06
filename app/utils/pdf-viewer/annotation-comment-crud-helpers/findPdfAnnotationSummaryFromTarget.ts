import type { IAnnotationCommentSummary } from '@app/types/annotations';

export function findPdfAnnotationSummaryFromTarget(
    target: HTMLElement,
    currentPage: number,
    annotationCommentsCache: IAnnotationCommentSummary[],
) {
    const annotationElement = target.closest<HTMLElement>(
        '.annotationLayer [data-annotation-id], .annotation-layer [data-annotation-id]',
    );
    if (!annotationElement) {
        return null;
    }

    const annotationId = annotationElement.dataset.annotationId ?? annotationElement.getAttribute('data-annotation-id');
    if (!annotationId) {
        return null;
    }

    const pageContainer = annotationElement.closest<HTMLElement>('.page_container');
    const pageNumber = pageContainer?.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage;
    const pageIndex = Math.max(0, pageNumber - 1);

    return annotationCommentsCache.find(c => (
        c.annotationId === annotationId && c.pageIndex === pageIndex
    )) ?? annotationCommentsCache.find(c => c.annotationId === annotationId) ?? null;
}
