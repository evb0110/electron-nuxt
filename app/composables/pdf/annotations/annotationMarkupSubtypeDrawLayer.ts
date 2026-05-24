import { tryOnScopeDispose } from '@vueuse/core';
import type { TMarkupSubtype } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    rectCenterDistance,
    rectIoU,
} from '@app/composables/pdf/annotationGeometry';
import {
    createTextMarkupDrawLayerVisualPlan,
    type ITextMarkupRect,
} from '@app/composables/pdf/textMarkupVisualModel';

const MARKUP_DRAW_LAYER_CLASS_PREFIX = 'pdf-markup-subtype-draw-';
const MARKUP_DRAW_LAYER_VISUAL_CLASS = 'pdf-markup-subtype-draw-visual';
const MARKUP_DRAW_LAYER_PATH_CLASS = 'pdf-markup-subtype-draw-path';
const MARKUP_VISUAL_READY_CLASS = 'pdf-markup-subtype-visual-ready';
const MAX_HIGHLIGHT_DRAW_LAYER_FALLBACK_DISTANCE = 40;
const SVG_NS = 'http://www.w3.org/2000/svg';
const DRAW_LAYER_RETRY_LIMIT = 18;
const DRAW_LAYER_RETRY_DELAY_MS = 50;

interface IHighlightDrawLayerCandidate {
    distance: number;
    overlapScore: number;
    svg: SVGElement;
}

function isRenderableRect(rect: DOMRect) {
    return rect.width > 0 && rect.height > 0;
}

function isFinitePositiveDimension(value: number) {
    return Number.isFinite(value) && value > 0;
}

function parseCssPercent(value: string) {
    const match = /^\s*(-?\d*\.?\d+)%\s*$/.exec(value);
    if (!match) {
        return null;
    }
    const parsed = Number.parseFloat(match[1]!);
    return Number.isFinite(parsed) ? parsed / 100 : null;
}

function resolveDrawLayerRectFromInlineStyle(svg: SVGElement): ITextMarkupRect | null {
    const left = parseCssPercent(svg.style.left);
    const top = parseCssPercent(svg.style.top);
    const width = parseCssPercent(svg.style.width);
    const height = parseCssPercent(svg.style.height);
    if (
        left === null
        || top === null
        || width === null
        || height === null
        || !isFinitePositiveDimension(width)
        || !isFinitePositiveDimension(height)
    ) {
        return null;
    }

    return {
        left,
        top,
        width,
        height,
    };
}

function resolveDrawLayerRectFromPageLayout(svg: SVGElement): ITextMarkupRect | null {
    const pageContainer = svg.closest<HTMLElement>('.page_container');
    if (!pageContainer) {
        return null;
    }
    const pageRect = pageContainer.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    if (!isRenderableRect(pageRect) || !isRenderableRect(svgRect)) {
        return null;
    }

    return {
        left: (svgRect.left - pageRect.left) / pageRect.width,
        top: (svgRect.top - pageRect.top) / pageRect.height,
        width: svgRect.width / pageRect.width,
        height: svgRect.height / pageRect.height,
    };
}

function resolveDrawLayerSvgRect(svg: SVGElement) {
    return resolveDrawLayerRectFromInlineStyle(svg)
        ?? resolveDrawLayerRectFromPageLayout(svg);
}

function resolveEditorPageDimensions(editor: IPdfjsEditor): [number, number] | null {
    const dimensions = editor.pageDimensions;
    if (
        !dimensions
        || dimensions.length < 2
        || !isFinitePositiveDimension(dimensions[0])
        || !isFinitePositiveDimension(dimensions[1])
    ) {
        return null;
    }
    return [
        dimensions[0],
        dimensions[1],
    ];
}

function toNativeStrokeCssLength(strokeWidthPdfUnits: number) {
    return `calc(var(--total-scale-factor, 1) * ${strokeWidthPdfUnits}px)`;
}

function toAttributeSelectorValue(value: string) {
    return value
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"');
}

function getOrCreateSvgDefs(svg: SVGElement) {
    const existing = svg.querySelector<SVGDefsElement>('defs');
    if (existing) {
        return existing;
    }
    const defs = document.createElementNS(SVG_NS, 'defs');
    svg.prepend(defs);
    return defs;
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
    let drawLayerVisualId = 0;
    let presentationToken = 0;
    let drawLayerStateVersion = 0;
    const knownHighlightSvgs = new Set<SVGElement>();
    const editorPresentationTokens = new WeakMap<IPdfjsEditor, number>();
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

    function beginEditorPresentation(editor: IPdfjsEditor) {
        presentationToken += 1;
        editorPresentationTokens.set(editor, presentationToken);
        return presentationToken;
    }

    function isEditorPresentationCurrent(editor: IPdfjsEditor, token: number, version: number) {
        return editorPresentationTokens.get(editor) === token
            && drawLayerStateVersion === version;
    }

    function resolveEditorDrawLayerHighlight(editor: IPdfjsEditor) {
        const cached = editorDrawLayerHighlightRefs.get(editor);
        if (cached?.isConnected) {
            knownHighlightSvgs.add(cached);
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
        const escapedClipPathId = toAttributeSelectorValue(clipPathId);
        const clipPathNode = pageContainer.querySelector<SVGElement>(`svg.highlight clipPath[id="${escapedClipPathId}"]`);
        let highlightSvg = clipPathNode?.closest<SVGElement>('svg.highlight') ?? null;
        if (!highlightSvg && editor.div) {
            highlightSvg = findClosestHighlightDrawLayerSvg(pageContainer, editor.div);
        }
        if (highlightSvg) {
            editorDrawLayerHighlightRefs.set(editor, highlightSvg);
            knownHighlightSvgs.add(highlightSvg);
        }
        return highlightSvg;
    }

    function clearMarkupSubtypeDrawLayerVisual(highlightSvg: SVGElement) {
        highlightSvg.querySelectorAll(
            `.${MARKUP_DRAW_LAYER_VISUAL_CLASS}, .${MARKUP_DRAW_LAYER_PATH_CLASS}`,
        ).forEach(node => node.remove());
        highlightSvg.classList.remove(
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}underline`,
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}strikeout`,
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}squiggly`,
        );
        highlightSvg.style.removeProperty('--pdf-markup-subtype-color');
    }

    function clearMarkupSubtypeDrawLayerClass(editor: IPdfjsEditor) {
        beginEditorPresentation(editor);
        editor.div?.classList.remove(MARKUP_VISUAL_READY_CLASS);
        const highlightSvg = resolveEditorDrawLayerHighlight(editor);
        if (!highlightSvg) {
            return;
        }
        clearMarkupSubtypeDrawLayerVisual(highlightSvg);
    }

    function appendMarkupSubtypeDrawLayerVisual(
        highlightSvg: SVGElement,
        subtype: TMarkupSubtype,
        color: string | null,
        plan: NonNullable<ReturnType<typeof createTextMarkupDrawLayerVisualPlan>>,
    ) {
        const defs = getOrCreateSvgDefs(highlightSvg);
        highlightSvg.setAttribute('viewBox', plan.viewBox);
        highlightSvg.classList.add(`${MARKUP_DRAW_LAYER_CLASS_PREFIX}${subtype.toLowerCase()}`);
        if (color) {
            highlightSvg.style.setProperty('--pdf-markup-subtype-color', color);
        }

        for (const pathPlan of plan.paths) {
            drawLayerVisualId += 1;
            const pathId = `pdf_markup_subtype_draw_${drawLayerVisualId}`;
            const path = document.createElementNS(SVG_NS, 'path');
            path.id = pathId;
            path.classList.add(MARKUP_DRAW_LAYER_PATH_CLASS);
            path.setAttribute('d', pathPlan.d);
            path.setAttribute('vector-effect', 'non-scaling-stroke');
            defs.append(path);

            const use = document.createElementNS(SVG_NS, 'use');
            use.classList.add(
                MARKUP_DRAW_LAYER_VISUAL_CLASS,
                `${MARKUP_DRAW_LAYER_VISUAL_CLASS}--${subtype.toLowerCase()}`,
            );
            use.setAttribute('href', `#${pathId}`);
            use.setAttribute('fill', 'none');
            use.setAttribute('stroke', 'var(--pdf-markup-subtype-color, currentColor)');
            use.setAttribute('stroke-linecap', 'butt');
            use.setAttribute('stroke-linejoin', 'miter');
            use.setAttribute('vector-effect', 'non-scaling-stroke');
            use.style.pointerEvents = 'none';
            use.style.strokeWidth = toNativeStrokeCssLength(pathPlan.strokeWidthPdfUnits);
            highlightSvg.append(use);
        }
    }

    function applyMarkupSubtypeDrawLayerClass(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype | null,
        color: string | null,
        attempt = 0,
        token = beginEditorPresentation(editor),
        stateVersion = drawLayerStateVersion,
    ) {
        if (!isEditorPresentationCurrent(editor, token, stateVersion)) {
            return false;
        }
        const highlightSvg = resolveEditorDrawLayerHighlight(editor);
        if (!highlightSvg) {
            if (attempt < DRAW_LAYER_RETRY_LIMIT && editor.div?.isConnected) {
                scheduleMarkupSubtypeRetry(() => {
                    applyMarkupSubtypeDrawLayerClass(editor, subtype, color, attempt + 1, token, stateVersion);
                }, DRAW_LAYER_RETRY_DELAY_MS);
            }
            return false;
        }
        clearMarkupSubtypeDrawLayerVisual(highlightSvg);
        if (!subtype || subtype === 'Highlight') {
            editor.div?.classList.remove(MARKUP_VISUAL_READY_CLASS);
            return true;
        }

        const drawLayerRect = resolveDrawLayerSvgRect(highlightSvg);
        const pageDimensions = resolveEditorPageDimensions(editor);
        if (!drawLayerRect || !pageDimensions || !editor.__evbMarkupBoxes?.length) {
            if (attempt < DRAW_LAYER_RETRY_LIMIT && editor.div?.isConnected) {
                scheduleMarkupSubtypeRetry(() => {
                    applyMarkupSubtypeDrawLayerClass(editor, subtype, color, attempt + 1, token, stateVersion);
                }, DRAW_LAYER_RETRY_DELAY_MS);
            }
            editor.div?.classList.remove(MARKUP_VISUAL_READY_CLASS);
            return false;
        }

        const plan = createTextMarkupDrawLayerVisualPlan({
            boxes: editor.__evbMarkupBoxes,
            drawLayerRect,
            pageDimensions,
            subtype,
        });
        if (!plan) {
            editor.div?.classList.remove(MARKUP_VISUAL_READY_CLASS);
            return false;
        }

        appendMarkupSubtypeDrawLayerVisual(highlightSvg, subtype, color, plan);
        if (!isEditorPresentationCurrent(editor, token, stateVersion)) {
            clearMarkupSubtypeDrawLayerVisual(highlightSvg);
            editor.div?.classList.remove(MARKUP_VISUAL_READY_CLASS);
            return false;
        }
        editor.div?.classList.add(MARKUP_VISUAL_READY_CLASS);
        return true;
    }

    function clearDrawLayerState() {
        drawLayerStateVersion += 1;
        editorDrawLayerHighlightRefs = new WeakMap();
        knownHighlightSvgs.forEach(clearMarkupSubtypeDrawLayerVisual);
        knownHighlightSvgs.clear();
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
