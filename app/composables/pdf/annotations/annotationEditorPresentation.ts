import type {
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { normalizeTextMarkupBoxesByLine } from '@app/composables/pdf/textMarkupVisualModel';

const MARKUP_EDITOR_CLASS_PREFIX = 'pdf-markup-subtype-';
const MARKUP_FRAGMENTED_EDITOR_CLASS = 'pdf-markup-subtype-fragmented';
const MARKUP_VISUAL_READY_CLASS = 'pdf-markup-subtype-visual-ready';

interface IAnnotationEditorPresentationOptions {
    resolveEditorMarkupSubtypeHintRect: (editor: IPdfjsEditor) => IAnnotationMarkerRect | null;
    resolveEditorMarkupSubtypeColor: (
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype,
        pageIndex: number,
    ) => string;
    clearMarkupSubtypeDrawLayerClass: (editor: IPdfjsEditor) => void;
    applyMarkupSubtypeDrawLayerClass: (
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype | null,
        color: string | null,
    ) => boolean;
}

export const normalizeMarkupSubtypeFragmentBoxes = normalizeTextMarkupBoxesByLine;

export function createAnnotationEditorPresentation(options: IAnnotationEditorPresentationOptions) {
    const {
        resolveEditorMarkupSubtypeColor,
        clearMarkupSubtypeDrawLayerClass,
        applyMarkupSubtypeDrawLayerClass,
    } = options;

    function clearMarkupSubtypeEditorClass(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            clearMarkupSubtypeDrawLayerClass(editor);
            return;
        }
        div.classList.remove(
            `${MARKUP_EDITOR_CLASS_PREFIX}highlight`,
            `${MARKUP_EDITOR_CLASS_PREFIX}underline`,
            `${MARKUP_EDITOR_CLASS_PREFIX}strikeout`,
            `${MARKUP_EDITOR_CLASS_PREFIX}squiggly`,
            MARKUP_FRAGMENTED_EDITOR_CLASS,
            MARKUP_VISUAL_READY_CLASS,
        );
        delete div.dataset.markupSubtype;
        delete div.dataset.markupSubtypeColor;
        div.style.removeProperty('--pdf-markup-subtype-color');
        clearMarkupSubtypeDrawLayerClass(editor);
    }

    function applyMarkupSubtypeDrawLayerVisual(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype | null,
        color: string | null,
    ) {
        const div = editor.div;
        if (!div || !subtype || subtype === 'Highlight') {
            return false;
        }
        const applied = applyMarkupSubtypeDrawLayerClass(editor, subtype, color);
        if (applied) {
            div.classList.add(MARKUP_FRAGMENTED_EDITOR_CLASS, MARKUP_VISUAL_READY_CLASS);
        } else {
            div.classList.remove(MARKUP_FRAGMENTED_EDITOR_CLASS, MARKUP_VISUAL_READY_CLASS);
        }
        return applied;
    }

    function applyEditorMarkupSubtypePresentation(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype | null,
        pageIndex: number,
    ) {
        const subtypeColor = subtype && subtype !== 'Highlight'
            ? resolveEditorMarkupSubtypeColor(editor, subtype, Math.max(0, pageIndex))
            : null;
        clearMarkupSubtypeEditorClass(editor);
        const div = editor.div;
        if (!div) {
            return;
        }
        if (!subtype || subtype === 'Highlight') {
            return;
        }
        const normalizedSubtype = subtype.toLowerCase();
        div.classList.add(`${MARKUP_EDITOR_CLASS_PREFIX}${normalizedSubtype}`);
        div.dataset.markupSubtype = normalizedSubtype;
        if (subtypeColor) {
            div.dataset.markupSubtypeColor = subtypeColor;
            div.style.setProperty('--pdf-markup-subtype-color', subtypeColor);
        }
        applyMarkupSubtypeDrawLayerVisual(editor, subtype, subtypeColor);
    }

    function resolveEditorSubtypeFromPresentation(editor: IPdfjsEditor): TMarkupSubtype | null {
        const div = editor.div;
        if (!div) {
            return null;
        }
        const explicit = div.dataset.markupSubtype?.trim().toLowerCase() ?? '';
        if (explicit === 'underline') {
            return 'Underline';
        }
        if (explicit === 'strikeout' || explicit === 'strikethrough') {
            return 'StrikeOut';
        }
        if (explicit === 'squiggly') {
            return 'Squiggly';
        }
        if (explicit === 'highlight') {
            return 'Highlight';
        }

        const classList = Array.from(div.classList);
        if (classList.some(name => name.includes(`${MARKUP_EDITOR_CLASS_PREFIX}underline`))) {
            return 'Underline';
        }
        if (classList.some(name => name.includes(`${MARKUP_EDITOR_CLASS_PREFIX}strikeout`))) {
            return 'StrikeOut';
        }
        if (classList.some(name => name.includes(`${MARKUP_EDITOR_CLASS_PREFIX}squiggly`))) {
            return 'Squiggly';
        }
        return null;
    }

    return {
        clearMarkupSubtypeEditorClass,
        applyEditorMarkupSubtypePresentation,
        resolveEditorSubtypeFromPresentation,
    };
}
