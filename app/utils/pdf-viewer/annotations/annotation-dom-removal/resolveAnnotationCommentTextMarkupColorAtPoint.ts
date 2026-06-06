import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics } from '@app/utils/pdf-viewer/annotations/annotation-dom-removal/resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics';

export function resolveAnnotationCommentTextMarkupColorAtPoint(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    clientX: number,
    clientY: number,
) {
    return resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
        container,
        comment,
        clientX,
        clientY,
    ).color;
}
