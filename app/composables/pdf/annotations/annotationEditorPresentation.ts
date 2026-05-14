import type {
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfjsEditor,
    IPdfjsHighlightBox,
} from '@app/types/pdfjs';
import { meanBy } from 'es-toolkit/math';

const MARKUP_EDITOR_CLASS_PREFIX = 'pdf-markup-subtype-';
const MARKUP_FRAGMENTED_EDITOR_CLASS = 'pdf-markup-subtype-fragmented';
const MARKUP_FRAGMENT_LAYER_CLASS = 'pdf-markup-subtype-fragments';
const MARKUP_FRAGMENT_CLASS = 'pdf-markup-subtype-fragment';
const SAME_MARKUP_LINE_CENTER_TOLERANCE_RATIO = 0.35;
const MIN_MARKUP_FRAGMENT_SIZE = 0.0005;

interface IIndexedHighlightBox {
    box: IPdfjsHighlightBox;
    centerY: number;
    index: number;
}

interface IHighlightLineGroup {
    boxes: IIndexedHighlightBox[];
    top: number;
    bottom: number;
    centerY: number;
    averageHeight: number;
}

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
    ) => void;
}

function isFinitePositiveHighlightBox(box: IPdfjsHighlightBox) {
    return Number.isFinite(box.x)
        && Number.isFinite(box.y)
        && Number.isFinite(box.width)
        && Number.isFinite(box.height)
        && box.width > 0
        && box.height > 0;
}

function createHighlightLineGroup(indexedBox: IIndexedHighlightBox): IHighlightLineGroup {
    const { box } = indexedBox;
    return {
        boxes: [indexedBox],
        top: box.y,
        bottom: box.y + box.height,
        centerY: indexedBox.centerY,
        averageHeight: box.height,
    };
}

function addBoxToHighlightLineGroup(group: IHighlightLineGroup, indexedBox: IIndexedHighlightBox) {
    const { box } = indexedBox;
    group.boxes.push(indexedBox);
    group.top = Math.min(group.top, box.y);
    group.bottom = Math.max(group.bottom, box.y + box.height);
    group.centerY = meanBy(group.boxes, item => item.centerY);
    group.averageHeight = meanBy(group.boxes, item => item.box.height);
}

function belongsToHighlightLineGroup(group: IHighlightLineGroup, indexedBox: IIndexedHighlightBox) {
    const tolerance = Math.max(group.averageHeight, indexedBox.box.height) * SAME_MARKUP_LINE_CENTER_TOLERANCE_RATIO;
    return Math.abs(indexedBox.centerY - group.centerY) <= tolerance;
}

function groupHighlightBoxesByLine(boxes: readonly IPdfjsHighlightBox[]) {
    const sortedBoxes = boxes
        .map((box, index) => ({
            box: { ...box },
            centerY: box.y + (box.height / 2),
            index,
        }))
        .filter(indexedBox => isFinitePositiveHighlightBox(indexedBox.box))
        .sort((left, right) => left.centerY - right.centerY || left.box.x - right.box.x);
    const groups: IHighlightLineGroup[] = [];

    for (const indexedBox of sortedBoxes) {
        const previousGroup = groups.at(-1);
        if (previousGroup && belongsToHighlightLineGroup(previousGroup, indexedBox)) {
            addBoxToHighlightLineGroup(previousGroup, indexedBox);
            continue;
        }
        groups.push(createHighlightLineGroup(indexedBox));
    }

    return groups;
}

export function normalizeMarkupSubtypeFragmentBoxes(
    boxes: readonly IPdfjsHighlightBox[],
): IPdfjsHighlightBox[] {
    const groups = groupHighlightBoxesByLine(boxes);
    if (groups.length === 0) {
        return [];
    }
    if (groups.length === 1) {
        return groups[0]!.boxes
            .sort((left, right) => left.index - right.index)
            .map(({ box }) => ({ ...box }));
    }

    const normalizedBoxes = new Map<number, IPdfjsHighlightBox>();
    groups.forEach((group, groupIndex) => {
        const previousGroup = groups[groupIndex - 1] ?? null;
        const nextGroup = groups[groupIndex + 1] ?? null;
        let lineTop = group.top;
        let lineBottom = group.bottom;

        if (previousGroup) {
            lineTop = Math.max(lineTop, (previousGroup.centerY + group.centerY) / 2);
        }
        if (nextGroup) {
            lineBottom = Math.min(lineBottom, (group.centerY + nextGroup.centerY) / 2);
        }
        if (lineBottom - lineTop < MIN_MARKUP_FRAGMENT_SIZE) {
            lineTop = group.top;
            lineBottom = group.bottom;
        }

        for (const {
            box,
            index,
        } of group.boxes) {
            normalizedBoxes.set(index, {
                ...box,
                y: lineTop,
                height: lineBottom - lineTop,
            });
        }
    });

    return [...normalizedBoxes]
        .sort((left, right) => left[0] - right[0])
        .map(([
            ,
            box,
        ]) => box);
}

function toRelativePercent(value: number, origin: number, size: number) {
    return `${((value - origin) / size) * 100}%`;
}

function toPercent(value: number, size: number) {
    return `${(value / size) * 100}%`;
}

function appendMarkupSubtypeFragment(
    layer: HTMLElement,
    subtype: TMarkupSubtype,
    editorRect: IAnnotationMarkerRect,
    box: IPdfjsHighlightBox,
) {
    const fragment = document.createElement('span');
    fragment.classList.add(
        MARKUP_FRAGMENT_CLASS,
        `${MARKUP_FRAGMENT_CLASS}--${subtype.toLowerCase()}`,
    );

    fragment.style.left = toRelativePercent(box.x, editorRect.left, editorRect.width);
    fragment.style.width = toPercent(box.width, editorRect.width);
    if (subtype === 'StrikeOut') {
        fragment.style.top = toRelativePercent(box.y + (box.height / 2), editorRect.top, editorRect.height);
        fragment.style.height = '0';
    } else {
        fragment.style.top = toRelativePercent(box.y, editorRect.top, editorRect.height);
        fragment.style.height = toPercent(box.height, editorRect.height);
    }
    layer.append(fragment);
}

export function createAnnotationEditorPresentation(options: IAnnotationEditorPresentationOptions) {
    const {
        resolveEditorMarkupSubtypeHintRect,
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
        );
        delete div.dataset.markupSubtype;
        delete div.dataset.markupSubtypeColor;
        div.style.removeProperty('--pdf-markup-subtype-color');
        div.querySelector(`.${MARKUP_FRAGMENT_LAYER_CLASS}`)?.remove();
        clearMarkupSubtypeDrawLayerClass(editor);
    }

    function applyMarkupSubtypeFragments(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype | null,
        color: string | null,
    ) {
        const div = editor.div;
        if (!div || !subtype || subtype === 'Highlight' || !editor.__evbMarkupBoxes?.length) {
            return;
        }
        const editorRect = resolveEditorMarkupSubtypeHintRect(editor);
        if (!editorRect) {
            return;
        }

        const layer = document.createElement('div');
        layer.className = MARKUP_FRAGMENT_LAYER_CLASS;
        layer.setAttribute('aria-hidden', 'true');
        if (color) {
            layer.style.setProperty('--pdf-markup-subtype-color', color);
        }

        for (const box of normalizeMarkupSubtypeFragmentBoxes(editor.__evbMarkupBoxes)) {
            appendMarkupSubtypeFragment(layer, subtype, editorRect, box);
        }
        div.classList.add(MARKUP_FRAGMENTED_EDITOR_CLASS);
        div.append(layer);
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
        applyMarkupSubtypeDrawLayerClass(editor, subtype, subtypeColor);
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
        applyMarkupSubtypeFragments(editor, subtype, subtypeColor);
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
