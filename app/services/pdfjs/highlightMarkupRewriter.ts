import type { TMarkupSubtype } from '@app/types/annotations';
import type {
    IPdfjsEditor,
    IPdfjsHighlightBox,
} from '@app/types/pdfjs';
import {
    areMarkupBoxesEqual,
    subtractMarkupBoxes,
} from '@app/services/pdfjs/highlightMarkupBoxGeometry';
import { asPdfjsEditor } from '@app/services/pdfjs/annotationEditorAdapter';
import type { getAnnotationEditorLayer } from '@app/services/pdfjs/annotationEditorAdapter';
import { BrowserLogger } from '@app/utils/browser-logger';

interface IHighlightMarkupSubtypeResolver {
    setEditorMarkupSubtypeOverride: (editor: IPdfjsEditor, pageIndex: number, subtype: TMarkupSubtype) => void;
    resolveEditorMarkupSubtypeOverride: (editor: IPdfjsEditor, pageIndex: number) => TMarkupSubtype | null;
    resolveEditorSubtypeFromPresentation: (editor: IPdfjsEditor) => TMarkupSubtype | null;
}

function cloneHighlightBoxes(boxes: readonly IPdfjsHighlightBox[]) {
    return boxes.map(box => ({ ...box }));
}

function errorToLogText(error: unknown) {
    const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : (() => {
                try {
                    return JSON.stringify(error);
                } catch {
                    return String(error);
                }
            })();
    const stack = error instanceof Error ? error.stack ?? '' : '';
    return stack
        ? `${message}\n${stack}`
        : message;
}

function getEditorMarkupBoxes(editor: IPdfjsEditor) {
    if (editor.__evbMarkupBoxes?.length) {
        return editor.__evbMarkupBoxes;
    }
    if (
        Number.isFinite(editor.x)
        && Number.isFinite(editor.y)
        && Number.isFinite(editor.width)
        && Number.isFinite(editor.height)
        && (editor.width ?? 0) > 0
        && (editor.height ?? 0) > 0
    ) {
        return [{
            x: editor.x!,
            y: editor.y!,
            width: editor.width!,
            height: editor.height!,
        }];
    }
    return null;
}

function getEditorMarkupSubtype(
    editor: IPdfjsEditor,
    pageIndex: number,
    markupSubtype: IHighlightMarkupSubtypeResolver,
) {
    return markupSubtype.resolveEditorMarkupSubtypeOverride(editor, pageIndex)
        ?? markupSubtype.resolveEditorSubtypeFromPresentation(editor);
}

function removeEditorWithoutSelection(editor: IPdfjsEditor) {
    try {
        // PDF.js private editor lifecycle method; re-audit on pdfjs-dist upgrades.
        editor.remove?.();
    } catch (removeError) {
        BrowserLogger.debug('annotations', `Failed to remove overlapped markup editor: ${errorToLogText(removeError)}`);
        try {
            // PDF.js private editor deletion fallback; re-audit on pdfjs-dist upgrades.
            editor.delete?.();
        } catch (deleteError) {
            BrowserLogger.debug('annotations', `Failed to delete overlapped markup editor: ${errorToLogText(deleteError)}`);
        }
    }
}

function createReplacementMarkupEditor(
    layer: ReturnType<typeof getAnnotationEditorLayer>,
    sourceEditor: IPdfjsEditor,
    pageIndex: number,
    subtype: TMarkupSubtype,
    boxes: IPdfjsHighlightBox[],
    markupSubtype: IHighlightMarkupSubtypeResolver,
) {
    // PDF.js private editor factory; re-audit on pdfjs-dist upgrades.
    const replacementEditor = asPdfjsEditor(layer?.createAndAddNewEditor(
        new PointerEvent('pointerdown'),
        false,
        {
            methodOfCreation: 'toolbar',
            boxes: cloneHighlightBoxes(boxes),
            color: sourceEditor.color,
            opacity: sourceEditor.opacity,
            text: '',
        },
    ));
    if (!replacementEditor) {
        return;
    }
    replacementEditor.__evbMarkupBoxes = cloneHighlightBoxes(boxes);
    replacementEditor.__evbMarkupSubtypeColor = sourceEditor.__evbMarkupSubtypeColor ?? null;
    markupSubtype.setEditorMarkupSubtypeOverride(replacementEditor, pageIndex, subtype);
}

export function replaceOverlappingSelectionMarkup(
    pageIndex: number,
    replacementBoxes: readonly IPdfjsHighlightBox[],
    replacementSubtype: TMarkupSubtype | null,
    getEditorsForPage: (pageIndex: number) => IPdfjsEditor[],
    layer: ReturnType<typeof getAnnotationEditorLayer>,
    markupSubtype: IHighlightMarkupSubtypeResolver,
) {
    if (!replacementSubtype || replacementSubtype === 'Highlight') {
        return;
    }

    for (const editor of getEditorsForPage(pageIndex)) {
        const existingSubtype = getEditorMarkupSubtype(editor, pageIndex, markupSubtype);
        const existingBoxes = getEditorMarkupBoxes(editor);
        if (existingSubtype !== replacementSubtype || !existingBoxes) {
            continue;
        }

        const remainingBoxes = subtractMarkupBoxes(existingBoxes, replacementBoxes);
        if (areMarkupBoxesEqual(remainingBoxes, existingBoxes)) {
            continue;
        }
        if (remainingBoxes.length > 0) {
            createReplacementMarkupEditor(layer, editor, pageIndex, existingSubtype, remainingBoxes, markupSubtype);
        }
        removeEditorWithoutSelection(editor);
    }
}
