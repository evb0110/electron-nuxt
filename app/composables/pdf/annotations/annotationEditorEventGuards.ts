export function shouldIgnoreEditorEvent(event: Event) {
    const candidateElements = [
        event.target,
        typeof document !== 'undefined' ? document.activeElement : null,
    ];

    for (const candidate of candidateElements) {
        if (!(candidate instanceof HTMLElement)) {
            continue;
        }
        if (candidate.closest('.text-layer, .textLayer')) {
            return true;
        }
        if (candidate.isContentEditable) {
            return true;
        }
        const tagName = candidate.tagName;
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
            return true;
        }
        if (candidate.closest('.pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog')) {
            return true;
        }
        if (candidate.closest('.note-window, .pdf-annotation-note-window')) {
            return true;
        }
        if (candidate.closest('[contenteditable="true"], [contenteditable=""]')) {
            return true;
        }
    }

    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) {
        const anchorParent = selection.anchorNode?.parentElement ?? null;
        const focusParent = selection.focusNode?.parentElement ?? null;
        if (
            anchorParent?.closest('.text-layer, .textLayer')
            || focusParent?.closest('.text-layer, .textLayer')
        ) {
            return true;
        }
    }
    return false;
}
