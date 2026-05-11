import { tryOnScopeDispose } from '@vueuse/core';
import type { TMarkupSubtype } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    rectCenterDistance,
    rectIoU,
} from '@app/composables/pdf/annotationGeometry';

const MARKUP_DRAW_LAYER_CLASS_PREFIX = 'pdf-markup-subtype-draw-';
const MAX_HIGHLIGHT_DRAW_LAYER_FALLBACK_DISTANCE = 40;

interface IHighlightDrawLayerCandidate {
    distance: number;
    overlapScore: number;
    svg: SVGElement;
}

function isRenderableRect(rect: DOMRect) {
    return rect.width > 0 && rect.height > 0;
}

function toHighlightDrawLayerCandidate(editorRect: DOMRect, svg: SVGElement): IHighlightDrawLayerCandidate | null {
    const rect = svg.getBoundingClientRect();
    if (!isRenderableRect(rect)) {
        return null;
    }
    const overlapScore = rectIoU(editorRect, rect);
    return {
        distance: overlapScore > 0 ? 0 : rectCenterDistance(editorRect, rect),
        overlapScore,
        svg,
    };
}

function pickBetterHighlightDrawLayerCandidate(
    current: IHighlightDrawLayerCandidate | null,
    candidate: IHighlightDrawLayerCandidate,
) {
    if (!current) {
        return candidate;
    }
    if (current.overlapScore > 0 || candidate.overlapScore > 0) {
        return candidate.overlapScore > current.overlapScore ? candidate : current;
    }
    return candidate.distance < current.distance ? candidate : current;
}

export function resolveEditorHighlightClipPathId(editor: IPdfjsEditor) {
    const internal = editor.div?.querySelector<HTMLElement>('.internal');
    if (!internal) {
        return null;
    }
    const clipPath = internal.style.clipPath || getComputedStyle(internal).clipPath;
    const clipMatch = /#([A-Za-z0-9_-]+)/.exec(clipPath);
    return clipMatch?.[1] ?? null;
}

export function findClosestHighlightDrawLayerSvg(pageContainer: HTMLElement, editorDiv: HTMLElement) {
    const editorRect = editorDiv.getBoundingClientRect();
    if (!isRenderableRect(editorRect)) {
        return null;
    }
    const candidates = Array.from(pageContainer.querySelectorAll<SVGElement>('svg.highlight'));
    let bestCandidate: IHighlightDrawLayerCandidate | null = null;

    for (const candidate of candidates) {
        const scoredCandidate = toHighlightDrawLayerCandidate(editorRect, candidate);
        if (!scoredCandidate) {
            continue;
        }
        bestCandidate = pickBetterHighlightDrawLayerCandidate(bestCandidate, scoredCandidate);
    }

    if (
        bestCandidate
        && (
            bestCandidate.overlapScore > 0
            || bestCandidate.distance <= MAX_HIGHLIGHT_DRAW_LAYER_FALLBACK_DISTANCE
        )
    ) {
        return bestCandidate.svg;
    }
    return null;
}

export function createAnnotationMarkupSubtypeDrawLayer() {
    let editorDrawLayerHighlightRefs = new WeakMap<IPdfjsEditor, SVGElement>();
    const markupSubtypeRetryTimers = new Set<ReturnType<typeof setTimeout>>();

    tryOnScopeDispose(() => {
        markupSubtypeRetryTimers.forEach(timer => clearTimeout(timer));
        markupSubtypeRetryTimers.clear();
    });

    function scheduleMarkupSubtypeRetry(run: () => void, delayMs: number) {
        const timer = setTimeout(() => {
            markupSubtypeRetryTimers.delete(timer);
            run();
        }, delayMs);
        markupSubtypeRetryTimers.add(timer);
    }

    function resolveEditorDrawLayerHighlight(editor: IPdfjsEditor) {
        const cached = editorDrawLayerHighlightRefs.get(editor);
        if (cached?.isConnected) {
            return cached;
        }
        const pageContainer = editor.div?.closest<HTMLElement>('.page_container');
        if (!pageContainer) {
            return null;
        }
        const clipPathId = resolveEditorHighlightClipPathId(editor);
        if (!clipPathId) {
            return null;
        }
        const escapedClipPathId = clipPathId.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
        const clipPathNode = pageContainer.querySelector<SVGElement>(`svg.highlight clipPath[id="${escapedClipPathId}"]`);
        let highlightSvg = clipPathNode?.closest<SVGElement>('svg.highlight') ?? null;
        if (!highlightSvg && editor.div) {
            highlightSvg = findClosestHighlightDrawLayerSvg(pageContainer, editor.div);
        }
        if (highlightSvg) {
            editorDrawLayerHighlightRefs.set(editor, highlightSvg);
        }
        return highlightSvg;
    }

    function clearMarkupSubtypeDrawLayerClass(editor: IPdfjsEditor) {
        const highlightSvg = resolveEditorDrawLayerHighlight(editor);
        if (!highlightSvg) {
            return;
        }
        highlightSvg.classList.remove(
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}underline`,
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}strikeout`,
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}squiggly`,
        );
        highlightSvg.style.removeProperty('--pdf-markup-subtype-color');
    }

    function applyMarkupSubtypeDrawLayerClass(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype | null,
        color: string | null,
        attempt = 0,
    ) {
        const highlightSvg = resolveEditorDrawLayerHighlight(editor);
        if (!highlightSvg) {
            if (attempt < 18 && editor.div?.isConnected) {
                scheduleMarkupSubtypeRetry(() => {
                    applyMarkupSubtypeDrawLayerClass(editor, subtype, color, attempt + 1);
                }, 50);
            }
            return;
        }
        clearMarkupSubtypeDrawLayerClass(editor);
        if (!subtype || subtype === 'Highlight') {
            return;
        }
        highlightSvg.classList.add(`${MARKUP_DRAW_LAYER_CLASS_PREFIX}${subtype.toLowerCase()}`);
        if (color) {
            highlightSvg.style.setProperty('--pdf-markup-subtype-color', color);
        }
    }

    function clearDrawLayerState() {
        editorDrawLayerHighlightRefs = new WeakMap();
        markupSubtypeRetryTimers.forEach(timer => clearTimeout(timer));
        markupSubtypeRetryTimers.clear();
    }

    return {
        resolveEditorDrawLayerHighlight,
        clearMarkupSubtypeDrawLayerClass,
        applyMarkupSubtypeDrawLayerClass,
        clearDrawLayerState,
    };
}
