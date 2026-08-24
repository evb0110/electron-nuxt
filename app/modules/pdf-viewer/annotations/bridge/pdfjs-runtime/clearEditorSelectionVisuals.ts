// PDF.js-private selection cleanup. Creating a text markup editor leaves the
// browser selection and pdf.js "selected editor" classes behind; clearing them
// takes several passes because pdf.js re-applies them across frames.
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { Ref } from 'vue';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { clearSelectedEditorState } from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';

const SELECTION_CLEAR_FALLBACK_DELAY_MS = 80;

interface IClearEditorSelectionVisualsOptions {
    viewerContainer: Ref<HTMLElement | null>;
    uiManager: AnnotationEditorUIManager;
    isUiManagerCurrent: () => boolean;
    editor: IPdfjsEditor | null;
}

function selectionHasEndpointInScope(selection: Selection, scope: HTMLElement) {
    if (
        (selection.anchorNode && scope.contains(selection.anchorNode))
        || (selection.focusNode && scope.contains(selection.focusNode))
    ) {
        return true;
    }
    for (let index = 0; index < selection.rangeCount; index += 1) {
        const range = selection.getRangeAt(index);
        if (scope.contains(range.startContainer) || scope.contains(range.endContainer)) {
            return true;
        }
    }
    return false;
}

export function clearEditorSelectionVisuals(options: IClearEditorSelectionVisualsOptions) {
    const {
        viewerContainer,
        uiManager,
        isUiManagerCurrent,
        editor,
    } = options;
    if (!isUiManagerCurrent()) {
        return;
    }
    const editorElement = editor?.div ?? null;
    const container = viewerContainer.value;
    // Portalled editor layers live outside the scroll container, so the host
    // element is the only scope that covers every node this viewer owns. A
    // wider scope would clear another viewer's selection.
    const cleanupScope = container?.closest<HTMLElement>('[data-pdf-viewer-host]') ?? container;
    clearSelectedEditorState(uiManager);

    // The deferred passes below already tolerate a missing document; the
    // synchronous ones have to as well, or this bridge throws on the server and
    // in DOM-less unit environments instead of doing nothing.
    const activeElement = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (activeElement && cleanupScope?.contains(activeElement) && activeElement !== document.body) {
        const insidePdfViewer = activeElement.closest(
            '.annotationEditorLayer, .annotation-editor-layer, .pdfViewer, .pdf-viewer',
        );
        if (insidePdfViewer) {
            activeElement.blur();
        }
    }

    const clearSelectionClasses = () => {
        // The later passes run up to 80 ms out. By then the host may already
        // show another document, whose selection is not ours to drop.
        if (typeof document === 'undefined' || !cleanupScope || !isUiManagerCurrent()) {
            return;
        }
        cleanupScope.querySelectorAll<HTMLElement>(
            '.annotationEditorLayer .selectedEditor, .annotationEditorLayer .selected, .annotation-editor-layer .selectedEditor, .annotation-editor-layer .selected',
        ).forEach((element) => {
            element.classList.remove('selectedEditor', 'selected');
        });
        cleanupScope.querySelectorAll<HTMLElement>(
            '.textLayer .highlight.selected, .text-layer .highlight.selected, .highlightOutline.selected',
        ).forEach((element) => {
            element.classList.remove('selected');
        });
        const selection = document.getSelection();
        if (selection && selectionHasEndpointInScope(selection, cleanupScope)) {
            selection.removeAllRanges();
        }
        editorElement?.classList.remove('selectedEditor', 'selected');
    };

    clearSelectionClasses();
    if (typeof window !== 'undefined') {
        window.requestAnimationFrame(clearSelectionClasses);
        window.setTimeout(clearSelectionClasses, 0);
        window.setTimeout(clearSelectionClasses, SELECTION_CLEAR_FALLBACK_DELAY_MS);
    }
}
