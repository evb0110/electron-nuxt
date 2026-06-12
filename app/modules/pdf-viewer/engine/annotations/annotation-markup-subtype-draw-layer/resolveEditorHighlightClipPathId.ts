import type { IPdfjsEditor } from '@app/types/pdfjs';

export function resolveEditorHighlightClipPathId(editor: IPdfjsEditor) {
    const internal = editor.div?.querySelector<HTMLElement>('.internal');
    if (!internal) {
        return null;
    }
    const clipPath = internal.style.clipPath || getComputedStyle(internal).clipPath;
    const clipMatch = /#([A-Za-z0-9_-]+)/.exec(clipPath);
    return clipMatch?.[1] ?? null;
}
