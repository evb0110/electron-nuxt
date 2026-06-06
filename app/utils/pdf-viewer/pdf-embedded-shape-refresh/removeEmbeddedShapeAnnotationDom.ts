import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';

export function removeEmbeddedShapeAnnotationDom(
    viewerContainer: HTMLElement | null,
    annotationId: string | null | undefined,
) {
    const normalizedAnnotationId = normalizePdfJsAnnotationId(annotationId);
    if (!viewerContainer || !normalizedAnnotationId) {
        return;
    }

    viewerContainer.querySelectorAll<HTMLElement>('[data-annotation-id]').forEach((element) => {
        if (normalizePdfJsAnnotationId(element.dataset.annotationId) === normalizedAnnotationId) {
            element.remove();
        }
    });

    viewerContainer.querySelectorAll<HTMLElement>(
        '.annotationLayer .popup[data-annotation-id], .annotation-layer .popup[data-annotation-id]',
    ).forEach((popup) => {
        const parentAnnotationId = normalizePdfJsAnnotationId(
            popup.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId,
        );
        if (parentAnnotationId === normalizedAnnotationId) {
            popup.remove();
        }
    });
}
