import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { getEditorsOnPage } from '@app/services/pdfjs/annotationEditorAdapter';
import type { IEditorTargetMatch } from '@app/utils/pdf-viewer/annotation-comment-crud-helpers/editorTargetMatch';

export function findEditorFromTarget(
    uiManager: AnnotationEditorUIManager | null,
    target: HTMLElement,
    currentPage: number,
): IEditorTargetMatch | null {
    if (!uiManager) {
        return null;
    }

    const targetAnnotationId = target.closest<HTMLElement>('[data-annotation-id]')
        ?.dataset.annotationId
        ?? null;

    const editorElement = target.closest<HTMLElement>(
        '.annotation-editor-layer .highlightEditor, .annotation-editor-layer .freeTextEditor, .annotation-editor-layer .inkEditor, .annotationEditorLayer .highlightEditor, .annotationEditorLayer .freeTextEditor, .annotationEditorLayer .inkEditor',
    );
    if (!editorElement) {
        return null;
    }

    const pageContainer = editorElement.closest<HTMLElement>('.page_container');
    const pageNumber = pageContainer?.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage;
    const pageIndex = Math.max(0, pageNumber - 1);

    for (const normalizedEditor of getEditorsOnPage(uiManager, pageIndex)) {
        const editorDiv = normalizedEditor.div;
        if (!editorDiv) {
            continue;
        }
        if (editorDiv === editorElement || editorDiv.contains(target)) {
            return {
                editor: normalizedEditor,
                pageIndex,
                targetAnnotationId,
            };
        }
    }

    return null;
}
