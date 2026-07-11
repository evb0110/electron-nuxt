import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { getPdfjsEditorFacadeState } from '@app/modules/pdf-viewer/engine/annotations/bridge/getPdfjsEditorFacadeState';

export const COMMENT_MARKER_ANCHOR_EDITOR_CLASS = 'pdf-comment-marker-anchor-editor';
export const COMMENT_MARKER_ANCHOR_EDITOR_ATTRIBUTE = 'data-evb-comment-marker-anchor';

function formatPercent(value: number) {
    return `${(value * 100).toFixed(2)}%`;
}

function tagCommentMarkerAnchorEditor(editor: IPdfjsEditor) {
    getPdfjsEditorFacadeState(editor).commentMarkerAnchor = true;

    const editorDiv = editor.div;
    if (!editorDiv) {
        return;
    }

    // Detached sticky notes keep a live PDF.js FreeText editor only as the
    // persistence anchor. The Vue marker is the real UI; leaving PDF.js chrome
    // active here causes stale rectangles to leak when unsaved markers move.
    editorDiv.classList.add(COMMENT_MARKER_ANCHOR_EDITOR_CLASS);
    editorDiv.setAttribute(COMMENT_MARKER_ANCHOR_EDITOR_ATTRIBUTE, 'true');
    editorDiv.setAttribute('aria-hidden', 'true');
    editorDiv.querySelector<HTMLElement>('[contenteditable], .internal')
        ?.setAttribute('aria-hidden', 'true');
}

export function markCommentMarkerAnchorEditor(editor: IPdfjsEditor) {
    tagCommentMarkerAnchorEditor(editor);
}

export function syncCommentMarkerAnchorEditor(
    editor: IPdfjsEditor,
    markerRect: IAnnotationMarkerRect | null | undefined,
) {
    tagCommentMarkerAnchorEditor(editor);

    const normalizedRect = normalizeMarkerRect(markerRect);
    if (!normalizedRect) {
        getPdfjsEditorFacadeState(editor).pendingAnchorRect = null;
        return false;
    }

    getPdfjsEditorFacadeState(editor).pendingAnchorRect = normalizedRect;
    editor.x = normalizedRect.left;
    editor.y = normalizedRect.top;
    editor.width = normalizedRect.width;
    editor.height = normalizedRect.height;

    editor.setDims?.();
    editor.fixAndSetPosition?.();

    const editorDiv = editor.div;
    if (editorDiv) {
        editorDiv.style.left = formatPercent(normalizedRect.left);
        editorDiv.style.top = formatPercent(normalizedRect.top);
        editorDiv.style.width = formatPercent(normalizedRect.width);
        editorDiv.style.height = formatPercent(normalizedRect.height);
    }

    return true;
}
