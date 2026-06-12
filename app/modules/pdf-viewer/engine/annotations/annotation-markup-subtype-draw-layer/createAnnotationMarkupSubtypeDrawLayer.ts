import { tryOnScopeDispose } from '@vueuse/core';
import type { TMarkupSubtype } from '@app/types/annotations';
import type {
    IPdfjsDrawLayer,
    IPdfjsEditor,
} from '@app/types/pdfjs';
import { rectCenterDistance } from '@app/modules/pdf-viewer/engine/annotation-geometry/rectCenterDistance';
import { rectIoU } from '@app/modules/pdf-viewer/engine/annotation-geometry/rectIoU';
import { createTextMarkupDrawLayerVisualPlan } from '@app/modules/pdf-viewer/engine/text-markup-visual-model/createTextMarkupDrawLayerVisualPlan';
import type { ITextMarkupRect } from '@app/modules/pdf-viewer/engine/text-markup-visual-model/textMarkupVisualModelTypes';
import { refreshHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/refreshHighlightCompositeOverlay';
import { findClosestHighlightDrawLayerSvg } from '@app/modules/pdf-viewer/engine/annotations/annotation-markup-subtype-draw-layer/findClosestHighlightDrawLayerSvg';
import { resolveEditorHighlightClipPathId } from '@app/modules/pdf-viewer/engine/annotations/annotation-markup-subtype-draw-layer/resolveEditorHighlightClipPathId';

const MARKUP_DRAW_LAYER_CLASS_PREFIX = 'pdf-markup-subtype-draw-';

const MARKUP_DRAW_LAYER_VISUAL_CLASS = 'pdf-markup-subtype-draw-visual';

const MARKUP_VISUAL_READY_CLASS = 'pdf-markup-subtype-visual-ready';

// PDF.js may insert drawLayer visuals as page-level SVG siblings rather than
// children of the highlight SVG, so cleanup has to scan the page wrappers.
const STANDALONE_MARKUP_DRAW_LAYER_VISUAL_SELECTOR = [
    '.page_canvas svg.pdf-markup-subtype-draw-visual',
    '.canvasWrapper svg.pdf-markup-subtype-draw-visual',
    '.page_canvas svg[class*="pdf-markup-subtype-draw-visual"]',
    '.canvasWrapper svg[class*="pdf-markup-subtype-draw-visual"]',
].join(', ');

const MAX_HIGHLIGHT_DRAW_LAYER_FALLBACK_DISTANCE = 40;

const DRAW_LAYER_RETRY_LIMIT = 18;

const DRAW_LAYER_RETRY_DELAY_MS = 50;

const SUPPRESSED_TEXT_MARKUP_FILL = 'transparent';

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

function setHighlightSvgPaintColor(svg: SVGElement, color: string) {
    svg.setAttribute('fill', color);
    svg.setAttribute('fill-opacity', '1');
    svg.style.setProperty('fill', color);
    svg.style.setProperty('fill-opacity', '1');
    svg.querySelectorAll<SVGElement>('path, rect, line, polyline, polygon, use').forEach((node) => {
        const fill = node.getAttribute('fill');
        if (!fill || fill !== 'none') {
            node.setAttribute('fill', color);
            node.setAttribute('fill-opacity', '1');
            node.style.setProperty('fill', color);
            node.style.setProperty('fill-opacity', '1');
        }
        const stroke = node.getAttribute('stroke');
        if (stroke && stroke !== 'none') {
            node.setAttribute('stroke', color);
            node.style.setProperty('stroke', color);
        }
    });
}

function suppressHighlightSvgFill(svg: SVGElement) {
    // Underline/strike/squiggly keep PDF.js' highlight SVG as the hit target,
    // but the filled base must be invisible to avoid drawing a rectangle.
    svg.setAttribute('fill', SUPPRESSED_TEXT_MARKUP_FILL);
    svg.setAttribute('fill-opacity', '0');
    svg.setAttribute('stroke', SUPPRESSED_TEXT_MARKUP_FILL);
    svg.setAttribute('stroke-opacity', '0');
    svg.style.setProperty('fill', SUPPRESSED_TEXT_MARKUP_FILL);
    svg.style.setProperty('fill-opacity', '0');
    svg.style.setProperty('stroke', SUPPRESSED_TEXT_MARKUP_FILL);
    svg.style.setProperty('stroke-opacity', '0');
    svg.querySelectorAll<SVGElement>('path, rect, line, polyline, polygon, use').forEach((node) => {
        const fill = node.getAttribute('fill');
        if (fill !== 'none') {
            node.setAttribute('fill', SUPPRESSED_TEXT_MARKUP_FILL);
            node.setAttribute('fill-opacity', '0');
            node.style.setProperty('fill', SUPPRESSED_TEXT_MARKUP_FILL);
            node.style.setProperty('fill-opacity', '0');
        }
        const stroke = node.getAttribute('stroke');
        if (stroke && stroke !== 'none') {
            node.setAttribute('stroke', SUPPRESSED_TEXT_MARKUP_FILL);
            node.setAttribute('stroke-opacity', '0');
            node.style.setProperty('stroke', SUPPRESSED_TEXT_MARKUP_FILL);
            node.style.setProperty('stroke-opacity', '0');
        }
    });
}

function isMatchingStandaloneSubtypeDrawLayerVisual(highlightSvg: SVGElement, visualSvg: SVGElement) {
    if (visualSvg === highlightSvg || highlightSvg.contains(visualSvg)) {
        return false;
    }
    const highlightRect = highlightSvg.getBoundingClientRect();
    const visualRect = visualSvg.getBoundingClientRect();
    if (!isRenderableRect(highlightRect) || !isRenderableRect(visualRect)) {
        return false;
    }
    return rectIoU(highlightRect, visualRect) > 0
        || rectCenterDistance(highlightRect, visualRect) <= MAX_HIGHLIGHT_DRAW_LAYER_FALLBACK_DISTANCE;
}

function removeStandaloneSubtypeDrawLayerVisuals(highlightSvg: SVGElement) {
    const pageContainer = highlightSvg.closest<HTMLElement>('.page_container');
    if (!pageContainer) {
        return;
    }
    pageContainer.querySelectorAll<SVGElement>(STANDALONE_MARKUP_DRAW_LAYER_VISUAL_SELECTOR)
        .forEach((visualSvg) => {
            if (isMatchingStandaloneSubtypeDrawLayerVisual(highlightSvg, visualSvg)) {
                visualSvg.remove();
            }
        });
}

export function createAnnotationMarkupSubtypeDrawLayer() {
    let editorDrawLayerHighlightRefs = new WeakMap<IPdfjsEditor, SVGElement>();
    let editorSubtypeDrawLayerRefs = new WeakMap<IPdfjsEditor, {
        drawLayer: IPdfjsDrawLayer;
        ids: number[];
    }>();
    let presentationToken = 0;
    let drawLayerStateVersion = 0;
    const knownHighlightSvgs = new Set<SVGElement>();
    const knownSubtypeDrawLayerVisuals = new Map<number, IPdfjsDrawLayer>();
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
        let highlightSvg: SVGElement | null = null;
        if (clipPathId) {
            const escapedClipPathId = toAttributeSelectorValue(clipPathId);
            const clipPathNode = pageContainer.querySelector<SVGElement>(`svg.highlight clipPath[id="${escapedClipPathId}"]`);
            highlightSvg = clipPathNode?.closest<SVGElement>('svg.highlight') ?? null;
        }
        if (!highlightSvg && editor.div) {
            highlightSvg = findClosestHighlightDrawLayerSvg(pageContainer, editor.div);
        }
        if (highlightSvg) {
            editorDrawLayerHighlightRefs.set(editor, highlightSvg);
            knownHighlightSvgs.add(highlightSvg);
        }
        return highlightSvg;
    }

    function resolveEditorDrawLayer(editor: IPdfjsEditor) {
        return editor.parent?.drawLayer ?? null;
    }

    function recolorEditorHighlightDrawLayer(editor: IPdfjsEditor, color: string) {
        const highlightSvg = resolveEditorDrawLayerHighlight(editor);
        if (!highlightSvg) {
            return false;
        }
        setHighlightSvgPaintColor(highlightSvg, color);
        const pageContainer = highlightSvg.closest<HTMLElement>('.page_container');
        if (pageContainer) {
            refreshHighlightCompositeOverlay(pageContainer);
        }
        return true;
    }

    function suppressEditorHighlightDrawLayerFill(editor: IPdfjsEditor) {
        const highlightSvg = resolveEditorDrawLayerHighlight(editor);
        if (!highlightSvg) {
            return false;
        }
        suppressHighlightSvgFill(highlightSvg);
        const pageContainer = highlightSvg.closest<HTMLElement>('.page_container');
        if (pageContainer) {
            refreshHighlightCompositeOverlay(pageContainer);
        }
        return true;
    }

    function removeSubtypeDrawLayerVisual(drawLayer: IPdfjsDrawLayer, id: number) {
        try {
            drawLayer.remove(id);
        } finally {
            knownSubtypeDrawLayerVisuals.delete(id);
        }
    }

    function clearEditorSubtypeDrawLayerVisuals(editor: IPdfjsEditor) {
        const refs = editorSubtypeDrawLayerRefs.get(editor);
        if (!refs) {
            return;
        }
        // drawLayer.remove keeps PDF.js' own bookkeeping in sync; removing only
        // the DOM node leaves stale visuals behind on later redraws.
        refs.ids.forEach(id => removeSubtypeDrawLayerVisual(refs.drawLayer, id));
        editorSubtypeDrawLayerRefs.delete(editor);
    }

    function clearMarkupSubtypeDrawLayerVisual(highlightSvg: SVGElement) {
        highlightSvg.querySelectorAll(
            `.${MARKUP_DRAW_LAYER_VISUAL_CLASS}`,
        ).forEach(node => node.remove());
        removeStandaloneSubtypeDrawLayerVisuals(highlightSvg);
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
        clearEditorSubtypeDrawLayerVisuals(editor);
        const highlightSvg = resolveEditorDrawLayerHighlight(editor);
        if (!highlightSvg) {
            return;
        }
        clearMarkupSubtypeDrawLayerVisual(highlightSvg);
    }

    function appendMarkupSubtypeDrawLayerVisual(
        editor: IPdfjsEditor,
        drawLayer: IPdfjsDrawLayer,
        drawLayerRect: ITextMarkupRect,
        highlightSvg: SVGElement,
        subtype: TMarkupSubtype,
        color: string | null,
        plan: NonNullable<ReturnType<typeof createTextMarkupDrawLayerVisualPlan>>,
    ) {
        highlightSvg.classList.add(`${MARKUP_DRAW_LAYER_CLASS_PREFIX}${subtype.toLowerCase()}`);
        if (color) {
            highlightSvg.style.setProperty('--pdf-markup-subtype-color', color);
        }
        const ids: number[] = [];

        try {
            for (const pathPlan of plan.paths) {
                const { id } = drawLayer.draw({
                    bbox: [
                        drawLayerRect.left,
                        drawLayerRect.top,
                        drawLayerRect.width,
                        drawLayerRect.height,
                    ],
                    root: {
                        viewBox: plan.viewBox,
                        fill: 'transparent',
                        'fill-opacity': '0',
                    },
                    rootClass: {
                        draw: true,
                        [MARKUP_DRAW_LAYER_VISUAL_CLASS]: true,
                        [`${MARKUP_DRAW_LAYER_VISUAL_CLASS}--${subtype.toLowerCase()}`]: true,
                        [`${MARKUP_DRAW_LAYER_CLASS_PREFIX}${subtype.toLowerCase()}`]: true,
                    },
                    path: {
                        d: pathPlan.d,
                        fill: 'none',
                        stroke: color ?? 'currentColor',
                        'stroke-linecap': 'butt',
                        'stroke-linejoin': 'miter',
                        'stroke-width': toNativeStrokeCssLength(pathPlan.strokeWidthPdfUnits),
                        'vector-effect': 'non-scaling-stroke',
                    },
                });
                ids.push(id);
                knownSubtypeDrawLayerVisuals.set(id, drawLayer);
            }
        } catch (error) {
            ids.forEach(id => removeSubtypeDrawLayerVisual(drawLayer, id));
            throw error;
        }
        editorSubtypeDrawLayerRefs.set(editor, {
            drawLayer,
            ids,
        });
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
        clearEditorSubtypeDrawLayerVisuals(editor);
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
        suppressHighlightSvgFill(highlightSvg);

        const drawLayerRect = resolveDrawLayerSvgRect(highlightSvg);
        const pageDimensions = resolveEditorPageDimensions(editor);
        const drawLayer = resolveEditorDrawLayer(editor);
        if (!drawLayer || !drawLayerRect || !pageDimensions || !editor.__evbMarkupBoxes?.length) {
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

        appendMarkupSubtypeDrawLayerVisual(editor, drawLayer, drawLayerRect, highlightSvg, subtype, color, plan);
        if (!isEditorPresentationCurrent(editor, token, stateVersion)) {
            clearMarkupSubtypeDrawLayerVisual(highlightSvg);
            clearEditorSubtypeDrawLayerVisuals(editor);
            editor.div?.classList.remove(MARKUP_VISUAL_READY_CLASS);
            return false;
        }
        editor.div?.classList.add(MARKUP_VISUAL_READY_CLASS);
        return true;
    }

    function clearDrawLayerState() {
        drawLayerStateVersion += 1;
        editorDrawLayerHighlightRefs = new WeakMap();
        editorSubtypeDrawLayerRefs = new WeakMap();
        knownHighlightSvgs.forEach(clearMarkupSubtypeDrawLayerVisual);
        knownHighlightSvgs.clear();
        knownSubtypeDrawLayerVisuals.forEach((drawLayer, id) => removeSubtypeDrawLayerVisual(drawLayer, id));
        knownSubtypeDrawLayerVisuals.clear();
        markupSubtypeRetryTimers.forEach(timer => clearTimeout(timer));
        markupSubtypeRetryTimers.clear();
    }

    return {
        resolveEditorDrawLayerHighlight,
        recolorEditorHighlightDrawLayer,
        suppressEditorHighlightDrawLayerFill,
        clearMarkupSubtypeDrawLayerClass,
        applyMarkupSubtypeDrawLayerClass,
        clearDrawLayerState,
    };
}
