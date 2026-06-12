const TEXT_LAYER_SELECTOR = '.text-layer, .textLayer';

const COMMENT_POPUP_SELECTOR = '.pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog';

const NOTE_WINDOW_SELECTOR = '.note-window, .pdf-annotation-note-window';

const CONTENT_EDITABLE_SELECTOR = '[contenteditable="true"], [contenteditable=""]';

const FORM_FIELD_TAGS = new Set([
    'INPUT',
    'TEXTAREA',
    'SELECT',
]);

function isFormFieldElement(element: HTMLElement) {
    return FORM_FIELD_TAGS.has(element.tagName);
}

function isInsideIgnoredEditorRegion(element: HTMLElement) {
    return Boolean(
        element.closest(TEXT_LAYER_SELECTOR)
        ?? element.closest(COMMENT_POPUP_SELECTOR)
        ?? element.closest(NOTE_WINDOW_SELECTOR)
        ?? element.closest(CONTENT_EDITABLE_SELECTOR),
    );
}

function shouldIgnoreCandidateElement(candidate: EventTarget | Element | null | undefined) {
    return candidate instanceof HTMLElement && (
        candidate.isContentEditable
        || isFormFieldElement(candidate)
        || isInsideIgnoredEditorRegion(candidate)
    );
}

function selectionEndpointIsInTextLayer(node: Node | null | undefined) {
    return Boolean(node?.parentElement?.closest(TEXT_LAYER_SELECTOR));
}

function selectionIsInsideTextLayer(selection: Selection | null) {
    return Boolean(
        selection
        && !selection.isCollapsed
        && (
            selectionEndpointIsInTextLayer(selection.anchorNode)
            || selectionEndpointIsInTextLayer(selection.focusNode)
        ),
    );
}

export function shouldIgnoreEditorEvent(event: Event) {
    const candidateElements = [
        event.target,
        typeof document !== 'undefined' ? document.activeElement : null,
    ];

    for (const candidate of candidateElements) {
        if (shouldIgnoreCandidateElement(candidate)) {
            return true;
        }
    }

    return selectionIsInsideTextLayer(document.getSelection());
}
