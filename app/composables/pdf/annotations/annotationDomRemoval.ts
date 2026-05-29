import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import {
    markerRectIoU,
    normalizeMarkerRect,
} from '@app/composables/pdf/annotationGeometry';
import { markerRectCenterDistance } from '@app/composables/pdf/annotations/annotationRules';
import { refreshHighlightCompositeOverlay } from '@app/composables/pdf/pdfHighlightCompositeOverlay';
import { normalizePdfJsAnnotationId } from '@app/composables/pdf/pdfSerializationRefs';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import {
    parseCssRgbColor,
    rgbToHex,
    toOpaqueHighlightDisplayColor,
} from '@app/composables/pdf/textMarkupColor';
import { BrowserLogger } from '@app/utils/browserLogger';

const MIN_HIGHLIGHT_VISUAL_IOU = 0.2;
const MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE = 0.025;
const TEXT_MARKUP_AXIS_TOLERANCE = 0.018;
const MIN_TEXT_MARKUP_HORIZONTAL_OVERLAP_RATIO = 0.2;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EDITED_TEXT_MARKUP_OVERLAY_SELECTOR = 'svg[data-evb-edited-text-markup-overlay="true"]';
const EDITED_TEXT_MARKUP_OVERLAY_CLASS = 'pdf-edited-text-markup-overlay';
const EDITED_TEXT_MARKUP_VISUAL_CLASS = 'pdf-edited-text-markup-overlay__visual';
const EDITED_TEXT_MARKUP_VISUAL_KEY_ATTR = 'data-evb-edited-text-markup-key';
const EDITED_TEXT_MARKUP_STROKE_WIDTHS: Record<Exclude<TMarkupSubtype, 'Highlight'>, string> = {
    Underline: 'calc(var(--total-scale-factor, 1) * 0.571px)',
    StrikeOut: 'calc(var(--total-scale-factor, 1) * 1px)',
    Squiggly: 'calc(var(--total-scale-factor, 1) * 1px)',
};
const EDITED_TEXT_MARKUP_THUMBNAIL_STROKE_WIDTH = 1;
const DEFAULT_EDITED_HIGHLIGHT_OVERLAY_OPACITY = 0.35;

interface IEditedTextMarkupVisualOptions { highlightOpacity?: number | null | undefined; }

interface IHighlightVisualCandidate {
    axisOverlap: boolean;
    distance: number;
    iou: number;
    svg: SVGElement;
}

interface ITextMarkupElementCandidate {
    axisOverlap: boolean;
    distance: number;
    element: HTMLElement;
    iou: number;
}

type TTextMarkupColorResolutionSource =
    | 'canvas'
    | 'fallback:none'
    | 'not-text-markup'
    | 'point:element'
    | 'point:nearby-element'
    | 'point:nearby-visual-node'
    | 'point:visual-node'
    | 'summary:element'
    | 'summary:visual-node'
    | 'visual:element'
    | 'visual:visual-node';

interface ITextMarkupColorReadResult {
    color: string;
    element: string;
    source: 'element' | 'visual-node';
}

interface IRgbColor {
    b: number;
    g: number;
    r: number;
}

interface IAnnotationSwatchRgb {
    color: string;
    rgb: IRgbColor;
}

export interface ITextMarkupColorResolutionDiagnostics {
    annotationId: string | null;
    color: string | null;
    element: string | null;
    fallbackSource?: TTextMarkupColorResolutionSource | null;
    pageNumber: number | null;
    pointElementCount?: number;
    source: TTextMarkupColorResolutionSource;
    subtype: string | null;
}

function getAnnotationId(element: HTMLElement) {
    return element.dataset.annotationId ?? element.getAttribute('data-annotation-id');
}

function collectMatchingAnnotationElements(container: HTMLElement, annotationId: string) {
    const normalizedTarget = normalizePdfJsAnnotationId(annotationId);
    if (!normalizedTarget) {
        return [];
    }

    return Array.from(container.querySelectorAll<HTMLElement>('[data-annotation-id]'))
        .filter((element) => normalizePdfJsAnnotationId(getAnnotationId(element)) === normalizedTarget);
}

function appendUniqueElement(elements: HTMLElement[], element: HTMLElement) {
    if (!elements.includes(element)) {
        elements.push(element);
    }
}

function collectRelatedPopupElements(container: HTMLElement, annotationId: string) {
    const normalizedTarget = normalizePdfJsAnnotationId(annotationId);
    if (!normalizedTarget) {
        return [];
    }

    return Array.from(container.querySelectorAll<HTMLElement>(
        '.annotationLayer .popup[data-annotation-id], .annotation-layer .popup[data-annotation-id]',
    )).filter((popup) => {
        const parentAnnotationId = popup.parentElement
            ?.closest<HTMLElement>('[data-annotation-id]')
            ?.dataset.annotationId;
        if (normalizePdfJsAnnotationId(parentAnnotationId) === normalizedTarget) {
            return true;
        }

        const ariaControls = popup.getAttribute('aria-controls') ?? '';
        return ariaControls.split(/\s+/).some((controlId) => (
            controlId === `pdfjs_internal_id_${normalizedTarget}`
            || controlId.endsWith(`_${normalizedTarget}`)
            || normalizePdfJsAnnotationId(controlId) === normalizedTarget
        ));
    });
}

function findPageContainers(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    annotationElements: HTMLElement[],
) {
    const pageContainers = new Set<HTMLElement>();

    annotationElements.forEach((element) => {
        const pageContainer = element.closest<HTMLElement>('.page_container');
        if (pageContainer) {
            pageContainers.add(pageContainer);
        }
    });

    if (Number.isFinite(comment.pageNumber) && comment.pageNumber > 0) {
        const pageNumber = Math.floor(comment.pageNumber);
        const pageContainer = container.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        );
        if (pageContainer) {
            pageContainers.add(pageContainer);
        }
    }

    return [...pageContainers];
}

function isTextMarkupElement(element: HTMLElement) {
    const className = String(element.className).toLowerCase();
    return className.includes('highlight')
        || className.includes('underline')
        || className.includes('strikeout')
        || className.includes('squiggly');
}

function shouldRemoveTextMarkupVisual(
    comment: IAnnotationCommentSummary,
    annotationElements: HTMLElement[],
) {
    return isTextMarkupSubtype(comment.subtype)
        || annotationElements.some(isTextMarkupElement);
}

function rectFromElement(
    pageContainer: HTMLElement,
    element: Element & { getBoundingClientRect: () => DOMRect; },
): IAnnotationMarkerRect | null {
    const pageRect = pageContainer.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    if (
        pageRect.width <= 0
        || pageRect.height <= 0
        || elementRect.width <= 0
        || elementRect.height <= 0
    ) {
        return null;
    }

    return normalizeMarkerRect({
        left: (elementRect.left - pageRect.left) / pageRect.width,
        top: (elementRect.top - pageRect.top) / pageRect.height,
        width: elementRect.width / pageRect.width,
        height: elementRect.height / pageRect.height,
    });
}

function getTargetRects(
    pageContainer: HTMLElement,
    comment: IAnnotationCommentSummary,
    annotationElements: HTMLElement[],
) {
    const targetRects: IAnnotationMarkerRect[] = [];
    const normalizedCommentRect = normalizeMarkerRect(comment.markerRect);
    if (normalizedCommentRect) {
        targetRects.push(normalizedCommentRect);
    }

    annotationElements.forEach((element) => {
        const pageForElement = element.closest<HTMLElement>('.page_container');
        if (pageForElement !== pageContainer) {
            return;
        }
        const elementRect = rectFromElement(pageContainer, element);
        if (elementRect) {
            targetRects.push(elementRect);
        }
    });

    return targetRects;
}

function getDrawLayerHighlightSvgs(pageContainer: HTMLElement) {
    return Array.from(pageContainer.querySelectorAll<SVGElement>(
        [
            '.page_canvas svg.highlight:not(.free)',
            '.canvasWrapper svg.highlight:not(.free)',
            '.annotationLayer section svg',
            '.annotation-layer section svg',
        ].join(', '),
    )).filter(svg => !svg.classList.contains('pdf-highlight-composite-overlay'));
}

function getDrawLayerTextMarkupSvgs(pageContainer: HTMLElement) {
    return Array.from(pageContainer.querySelectorAll<SVGElement>(
        [
            '.page_canvas svg.highlight:not(.free)',
            '.canvasWrapper svg.highlight:not(.free)',
            '.page_canvas svg.pdf-markup-subtype-draw-visual',
            '.canvasWrapper svg.pdf-markup-subtype-draw-visual',
            '.page_canvas svg[class*="pdf-markup-subtype-draw-visual"]',
            '.canvasWrapper svg[class*="pdf-markup-subtype-draw-visual"]',
            '.annotationLayer section svg',
            '.annotation-layer section svg',
        ].join(', '),
    )).filter(svg => !svg.classList.contains('pdf-highlight-composite-overlay'));
}

function intervalOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
    return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function rectHasTextMarkupAxisOverlap(
    candidateRect: IAnnotationMarkerRect,
    targetRect: IAnnotationMarkerRect,
) {
    const targetLeft = targetRect.left - TEXT_MARKUP_AXIS_TOLERANCE;
    const targetRight = targetRect.left + targetRect.width + TEXT_MARKUP_AXIS_TOLERANCE;
    const targetTop = targetRect.top - TEXT_MARKUP_AXIS_TOLERANCE;
    const targetBottom = targetRect.top + targetRect.height + TEXT_MARKUP_AXIS_TOLERANCE;
    const candidateCenterX = candidateRect.left + candidateRect.width / 2;
    const candidateCenterY = candidateRect.top + candidateRect.height / 2;
    if (
        candidateCenterX < targetLeft
        || candidateCenterX > targetRight
        || candidateCenterY < targetTop
        || candidateCenterY > targetBottom
    ) {
        return false;
    }

    const horizontalOverlap = intervalOverlap(
        candidateRect.left,
        candidateRect.left + candidateRect.width,
        targetLeft,
        targetRight,
    );
    return horizontalOverlap / Math.max(candidateRect.width, Number.EPSILON)
        >= MIN_TEXT_MARKUP_HORIZONTAL_OVERLAP_RATIO;
}

function toHighlightVisualCandidate(
    pageContainer: HTMLElement,
    svg: SVGElement,
    targetRects: IAnnotationMarkerRect[],
): IHighlightVisualCandidate | null {
    const svgRect = rectFromElement(pageContainer, svg);
    if (!svgRect) {
        return null;
    }

    let best: IHighlightVisualCandidate | null = null;
    targetRects.forEach((targetRect) => {
        const iou = markerRectIoU(svgRect, targetRect);
        const distance = markerRectCenterDistance(svgRect, targetRect);
        const axisOverlap = rectHasTextMarkupAxisOverlap(svgRect, targetRect);
        const candidate: IHighlightVisualCandidate = {
            axisOverlap,
            distance,
            iou,
            svg,
        };
        if (
            !best
            || candidate.iou > best.iou
            || (
                candidate.iou === best.iou
                && Number(candidate.axisOverlap) > Number(best.axisOverlap)
            )
            || (
                candidate.iou === best.iou
                && candidate.axisOverlap === best.axisOverlap
                && candidate.distance < best.distance
            )
        ) {
            best = candidate;
        }
    });

    return best;
}

function isMatchedHighlightVisual(candidate: IHighlightVisualCandidate) {
    return candidate.iou >= MIN_HIGHLIGHT_VISUAL_IOU
        || candidate.distance <= MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE
        || candidate.axisOverlap;
}

function pickBetterHighlightVisualCandidate(
    current: IHighlightVisualCandidate | null,
    candidate: IHighlightVisualCandidate,
) {
    if (!current) {
        return candidate;
    }
    if (current.iou > 0 || candidate.iou > 0) {
        return candidate.iou > current.iou ? candidate : current;
    }
    if (current.axisOverlap !== candidate.axisOverlap) {
        return candidate.axisOverlap ? candidate : current;
    }
    return candidate.distance < current.distance ? candidate : current;
}

function collectMatchingHighlightVisuals(
    pageContainer: HTMLElement,
    targetRects: IAnnotationMarkerRect[],
) {
    const candidates: IHighlightVisualCandidate[] = [];
    if (targetRects.length === 0) {
        return candidates;
    }

    for (const svg of getDrawLayerTextMarkupSvgs(pageContainer)) {
        const candidate = toHighlightVisualCandidate(pageContainer, svg, targetRects);
        if (!candidate || !isMatchedHighlightVisual(candidate)) {
            continue;
        }
        candidates.push(candidate);
    }
    return candidates.sort((left, right) => (
        right.iou - left.iou
        || Number(right.axisOverlap) - Number(left.axisOverlap)
        || left.distance - right.distance
    ));
}

function isFullyTransparentColor(value: string) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || trimmed === 'transparent' || trimmed === 'none') {
        return true;
    }
    if (/\/\s*0(?:\.0+)?%?\s*\)?$/.test(trimmed)) {
        return true;
    }
    const match = /^rgba?\((?<channels>.+)\)$/i.exec(trimmed);
    const alpha = match?.groups?.channels
        ?.match(/-?\d*\.?\d+%?/g)
        ?.at(3);
    if (!alpha) {
        return false;
    }
    const normalizedAlpha = alpha.endsWith('%')
        ? Number.parseFloat(alpha.slice(0, -1)) / 100
        : Number.parseFloat(alpha);
    return Number.isFinite(normalizedAlpha) && normalizedAlpha <= 0;
}

function normalizeVisibleCssColor(value: string | null | undefined) {
    const trimmed = value?.trim() ?? '';
    if (isFullyTransparentColor(trimmed) || trimmed === 'currentcolor') {
        return null;
    }
    const parsed = parseCssRgbColor(trimmed);
    return parsed ? rgbToHex(parsed) : null;
}

function firstVisibleCssColor(values: Array<string | null | undefined>) {
    for (const value of values) {
        const color = normalizeVisibleCssColor(value);
        if (color) {
            return color;
        }
    }
    return null;
}

function readComputedStyle(element: Element) {
    try {
        return typeof getComputedStyle === 'function'
            ? getComputedStyle(element)
            : null;
    } catch {
        return null;
    }
}

function isElementHiddenForColorRead(element: Element) {
    let current: Element | null = element;
    while (current) {
        const style = readComputedStyle(current);
        const opacity = style?.opacity ? Number.parseFloat(style.opacity) : Number.NaN;
        if (
            style?.display === 'none'
            || style?.visibility === 'hidden'
            || style?.visibility === 'collapse'
            || (Number.isFinite(opacity) && opacity <= 0.01)
        ) {
            return true;
        }
        current = current.parentElement;
    }
    return false;
}

function describeColorElement(element: Element) {
    const tagName = typeof element.tagName === 'string'
        ? element.tagName.toLowerCase()
        : 'element';
    const className = typeof element.className === 'string'
        ? element.className
        : '';
    const id = element.id ? `#${element.id}` : '';
    const classes = className
        ? `.${className.trim().split(/\s+/).slice(0, 3).join('.')}`
        : '';
    const annotationId = typeof HTMLElement !== 'undefined' && element instanceof HTMLElement
        ? (getAnnotationId(element) ?? '')
        : '';
    const annotation = annotationId ? `[data-annotation-id="${annotationId}"]` : '';
    return `${tagName}${id}${classes}${annotation}`;
}

function getElementClassName(element: Element | null | undefined) {
    if (!element) {
        return '';
    }
    const classAttribute = element.getAttribute('class');
    if (classAttribute) {
        return classAttribute;
    }
    const className = (element as { className?: unknown }).className;
    if (typeof className === 'string') {
        return className;
    }
    return '';
}

function elementHasClassFragment(element: Element | null | undefined, fragment: string) {
    return getElementClassName(element).split(/\s+/).some(className => className.includes(fragment));
}

function isSubtypeDrawVisualElement(element: Element | null | undefined) {
    return elementHasClassFragment(element, 'pdf-markup-subtype-draw-visual')
        || elementHasClassFragment(element, 'pdf-markup-subtype-draw-underline')
        || elementHasClassFragment(element, 'pdf-markup-subtype-draw-strikeout')
        || elementHasClassFragment(element, 'pdf-markup-subtype-draw-squiggly');
}

function isSubtypeDrawStrokeVisualElement(element: Element | null | undefined) {
    return elementHasClassFragment(element, 'pdf-markup-subtype-draw-visual');
}

function isSvgPaintElement(element: Element | null | undefined) {
    const tagName = element?.tagName?.toLowerCase() ?? '';
    return tagName === 'svg'
        || tagName === 'path'
        || tagName === 'rect'
        || tagName === 'line'
        || tagName === 'polyline'
        || tagName === 'polygon'
        || tagName === 'use';
}

function shouldReadNonHighlightCustomColor(element: Element) {
    return isSubtypeDrawStrokeVisualElement(element)
        || elementHasClassFragment(element, 'pdf-markup-subtype-underline')
        || elementHasClassFragment(element, 'pdf-markup-subtype-strikeout')
        || elementHasClassFragment(element, 'pdf-markup-subtype-squiggly')
        || Boolean((element as HTMLElement).dataset?.markupSubtypeColor);
}

function readElementTextMarkupColorResult(
    element: Element,
    subtype: string,
): ITextMarkupColorReadResult | null {
    if (isElementHiddenForColorRead(element)) {
        return null;
    }
    const style = readComputedStyle(element);
    const hasTextDecorationColor = subtype !== 'highlight'
        && style?.textDecorationLine !== undefined
        && style.textDecorationLine !== 'none'
        && style.textDecorationLine.trim().length > 0;
    const hasBottomBorderColor = subtype !== 'highlight'
        && style?.borderBottomStyle !== undefined
        && style.borderBottomStyle !== 'none'
        && style.borderBottomWidth !== '0px';
    const hasTopBorderColor = subtype !== 'highlight'
        && style?.borderTopStyle !== undefined
        && style.borderTopStyle !== 'none'
        && style.borderTopWidth !== '0px';
    const ownColor = firstVisibleCssColor([
        subtype === 'highlight'
            ? (element as HTMLElement).style?.getPropertyValue('--pdf-markup-subtype-color')
            : null,
        subtype === 'highlight' ? style?.getPropertyValue('--pdf-markup-subtype-color') : null,
        subtype !== 'highlight' && shouldReadNonHighlightCustomColor(element)
            ? (element as HTMLElement).style?.getPropertyValue('--pdf-markup-subtype-color')
            : null,
        subtype !== 'highlight' && shouldReadNonHighlightCustomColor(element)
            ? style?.getPropertyValue('--pdf-markup-subtype-color')
            : null,
        subtype === 'highlight' ? style?.backgroundColor : null,
        subtype === 'highlight' && isSvgPaintElement(element) ? style?.fill : null,
        subtype === 'highlight' && isSvgPaintElement(element) ? element.getAttribute('fill') : null,
        hasTextDecorationColor ? style?.textDecorationColor : null,
        hasBottomBorderColor ? style?.borderBottomColor : null,
        hasTopBorderColor ? style?.borderTopColor : null,
        subtype === 'highlight' ? null : style?.stroke,
        subtype === 'highlight' ? null : element.getAttribute('stroke'),
    ]);
    if (ownColor) {
        return {
            color: ownColor,
            element: describeColorElement(element),
            source: 'element',
        };
    }

    const visualNodes = element.querySelectorAll<SVGElement>('svg, path, rect, line, polyline, polygon, use, mark, u, s');
    for (const node of visualNodes) {
        if (isElementHiddenForColorRead(node)) {
            continue;
        }
        const nodeStyle = readComputedStyle(node);
        const hasNodeTextDecorationColor = subtype !== 'highlight'
            && nodeStyle?.textDecorationLine !== undefined
            && nodeStyle.textDecorationLine !== 'none'
            && nodeStyle.textDecorationLine.trim().length > 0;
        const allowNonHighlightCustomColor = subtype !== 'highlight'
            && shouldReadNonHighlightCustomColor(node);
        const nodeColor = firstVisibleCssColor([
            subtype === 'highlight' ? node.style.getPropertyValue('--pdf-markup-subtype-color') : null,
            subtype === 'highlight' ? nodeStyle?.getPropertyValue('--pdf-markup-subtype-color') : null,
            subtype === 'highlight' ? null : nodeStyle?.stroke,
            subtype === 'highlight' ? null : node.getAttribute('stroke'),
            allowNonHighlightCustomColor ? node.style.getPropertyValue('--pdf-markup-subtype-color') : null,
            allowNonHighlightCustomColor ? nodeStyle?.getPropertyValue('--pdf-markup-subtype-color') : null,
            subtype === 'highlight' ? nodeStyle?.fill : null,
            subtype === 'highlight' ? node.getAttribute('fill') : null,
            subtype === 'highlight' ? nodeStyle?.backgroundColor : null,
            hasNodeTextDecorationColor ? nodeStyle?.textDecorationColor : null,
        ]);
        if (nodeColor) {
            return {
                color: nodeColor,
                element: describeColorElement(node),
                source: 'visual-node',
            };
        }
    }
    return null;
}

function appendUniqueElementLike(elements: Element[], element: Element | null | undefined) {
    if (element && !elements.includes(element)) {
        elements.push(element);
    }
}

function collectTextMarkupElementsFromPoint(
    container: HTMLElement,
    clientX: number,
    clientY: number,
) {
    const doc = container.ownerDocument;
    const elementsFromPoint = typeof doc.elementsFromPoint === 'function'
        ? doc.elementsFromPoint(clientX, clientY)
        : [];
    const candidates: Element[] = [];
    elementsFromPoint.forEach((element) => {
        if (!container.contains(element)) {
            return;
        }
        appendUniqueElementLike(candidates, element);
        appendUniqueElementLike(candidates, element.closest('[data-annotation-id]'));
        appendUniqueElementLike(candidates, element.closest('svg.highlight'));
        appendUniqueElementLike(candidates, element.closest('[class*="pdf-markup-subtype"]'));
        let parent = element.parentElement;
        while (parent && parent !== container) {
            if (
                parent.matches('[data-annotation-id]')
                || parent.matches('svg.highlight')
                || parent.matches('[class*="pdf-markup-subtype"]')
            ) {
                appendUniqueElementLike(candidates, parent);
            }
            parent = parent.parentElement;
        }
    });
    return candidates;
}

function pointDistanceToRect(clientX: number, clientY: number, rect: DOMRect) {
    const dx = clientX < rect.left
        ? rect.left - clientX
        : clientX > rect.right
            ? clientX - rect.right
            : 0;
    const dy = clientY < rect.top
        ? rect.top - clientY
        : clientY > rect.bottom
            ? clientY - rect.bottom
            : 0;
    return Math.hypot(dx, dy);
}

function getTextMarkupLineCandidateScore(
    element: Element,
    clientX: number,
    clientY: number,
) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height < 0) {
        return null;
    }
    const tolerance = Math.max(4, Math.min(10, rect.height + 4));
    const distance = pointDistanceToRect(clientX, clientY, rect);
    if (distance > tolerance) {
        return null;
    }
    const priority = isSubtypeDrawVisualElement(element)
        ? 0
        : getElementClassName(element).includes('highlight')
            ? 2
            : 1;
    return (priority * 1_000_000)
        + (distance * 1_000)
        + Math.min(rect.width * Math.max(rect.height, 1), 100_000);
}

function collectTextMarkupLineColorElementsNearPoint(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    subtype: string,
    clientX: number,
    clientY: number,
) {
    if (subtype === 'highlight') {
        return [];
    }
    const pageContainer = resolvePageContainerAtPoint(container, comment, clientX, clientY);
    if (!pageContainer || !container.contains(pageContainer)) {
        return [];
    }
    const selector = [
        '[class*="pdf-markup-subtype-draw"]',
        '[class*="pdf-markup-subtype-draw"] *',
        '.annotationEditorLayer [data-markup-subtype-color]',
        '.annotation-editor-layer [data-markup-subtype-color]',
        '.annotationLayer section svg',
        '.annotationLayer section svg *',
        '.annotation-layer section svg',
        '.annotation-layer section svg *',
        'svg.highlight:not(.free)',
        'svg.highlight:not(.free) *',
    ].join(', ');
    const candidates: Array<{
        element: Element;
        score: number;
    }> = [];
    pageContainer.querySelectorAll<Element>(selector).forEach((element) => {
        if (isElementHiddenForColorRead(element)) {
            return;
        }
        const score = getTextMarkupLineCandidateScore(element, clientX, clientY);
        if (score === null) {
            return;
        }
        candidates.push({
            element,
            score,
        });
    });
    return candidates
        .sort((left, right) => left.score - right.score)
        .map(candidate => candidate.element);
}

function colorDistanceScoreFromPoint(
    dx: number,
    dy: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
) {
    if (alpha < 32) {
        return null;
    }
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 245 && min > 245) {
        return null;
    }
    if (max < 50) {
        return null;
    }
    const saturation = max === 0 ? 0 : (max - min) / max;
    if (saturation < 0.18) {
        return null;
    }
    return (saturation * max) - Math.hypot(dx, dy) * 18;
}

function sampleCanvasTextMarkupColorAtPoint(
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number,
) {
    const rect = canvas.getBoundingClientRect();
    if (
        rect.width <= 0
        || rect.height <= 0
        || clientX < rect.left
        || clientX > rect.right
        || clientY < rect.top
        || clientY > rect.bottom
    ) {
        return null;
    }
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        return null;
    }

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const centerX = Math.round((clientX - rect.left) * scaleX);
    const centerY = Math.round((clientY - rect.top) * scaleY);
    const radiusX = Math.max(2, Math.round(7 * scaleX));
    const radiusY = Math.max(2, Math.round(7 * scaleY));
    const left = Math.max(0, centerX - radiusX);
    const top = Math.max(0, centerY - radiusY);
    const width = Math.min(canvas.width - left, radiusX * 2 + 1);
    const height = Math.min(canvas.height - top, radiusY * 2 + 1);
    if (width <= 0 || height <= 0) {
        return null;
    }

    let data: ImageData;
    try {
        data = context.getImageData(left, top, width, height);
    } catch {
        return null;
    }

    let best: {
        color: string;
        score: number;
    } | null = null;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 4;
            const r = data.data[index]!;
            const g = data.data[index + 1]!;
            const b = data.data[index + 2]!;
            const alpha = data.data[index + 3]!;
            const score = colorDistanceScoreFromPoint(
                (left + x - centerX) / scaleX,
                (top + y - centerY) / scaleY,
                r,
                g,
                b,
                alpha,
            );
            if (score === null || (best && score <= best.score)) {
                continue;
            }
            best = {
                color: rgbToHex({
                    r,
                    g,
                    b,
                }),
                score,
            };
        }
    }
    return best?.color ?? null;
}

function parseHexColor(value: string): IRgbColor | null {
    const match = /^#(?<r>[0-9a-f]{2})(?<g>[0-9a-f]{2})(?<b>[0-9a-f]{2})$/iu.exec(value);
    const groups = match?.groups;
    if (!groups?.r || !groups.g || !groups.b) {
        return null;
    }
    return {
        r: Number.parseInt(groups.r, 16),
        g: Number.parseInt(groups.g, 16),
        b: Number.parseInt(groups.b, 16),
    };
}

const ANNOTATION_SWATCH_RGB: IAnnotationSwatchRgb[] = ANNOTATION_COLOR_SWATCHES.flatMap((color) => {
    const rgb = parseHexColor(color);
    return rgb
        ? [{
            color,
            rgb,
        }]
        : [];
});

function nearestAnnotationSwatch(r: number, g: number, b: number): string {
    let bestColor: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of ANNOTATION_SWATCH_RGB) {
        const distance = Math.hypot(
            r - entry.rgb.r,
            g - entry.rgb.g,
            b - entry.rgb.b,
        );
        if (distance < bestDistance) {
            bestColor = entry.color;
            bestDistance = distance;
        }
    }
    if (bestColor) {
        return bestColor;
    }
    return rgbToHex({
        r,
        g,
        b,
    });
}

function sampleCanvasTextMarkupColorInRect(
    canvas: HTMLCanvasElement,
    pageContainer: HTMLElement,
    targetRect: IAnnotationMarkerRect,
): string | null {
    const canvasRect = canvas.getBoundingClientRect();
    const pageRect = pageContainer.getBoundingClientRect();
    if (
        canvasRect.width <= 0
        || canvasRect.height <= 0
        || pageRect.width <= 0
        || pageRect.height <= 0
    ) {
        return null;
    }
    const viewportLeft = pageRect.left + targetRect.left * pageRect.width;
    const viewportTop = pageRect.top + targetRect.top * pageRect.height;
    const viewportWidth = targetRect.width * pageRect.width;
    const viewportHeight = targetRect.height * pageRect.height;
    const sampleLeft = Math.max(canvasRect.left, viewportLeft);
    const sampleTop = Math.max(canvasRect.top, viewportTop);
    const sampleRight = Math.min(canvasRect.right, viewportLeft + viewportWidth);
    const sampleBottom = Math.min(canvasRect.bottom, viewportTop + viewportHeight);
    if (sampleRight <= sampleLeft || sampleBottom <= sampleTop) {
        return null;
    }

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        return null;
    }

    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    const left = Math.max(0, Math.floor((sampleLeft - canvasRect.left) * scaleX));
    const top = Math.max(0, Math.floor((sampleTop - canvasRect.top) * scaleY));
    const right = Math.min(canvas.width, Math.ceil((sampleRight - canvasRect.left) * scaleX));
    const bottom = Math.min(canvas.height, Math.ceil((sampleBottom - canvasRect.top) * scaleY));
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) {
        return null;
    }

    let data: ImageData;
    try {
        data = context.getImageData(left, top, width, height);
    } catch {
        return null;
    }

    const counts = new Map<string, number>();
    const pixels: Uint8ClampedArray = data.data;
    const stride = Math.max(1, Math.floor(Math.min(width, height) / 180));
    for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < width; x += stride) {
            const index = (y * width + x) * 4;
            const r = pixels[index]!;
            const g = pixels[index + 1]!;
            const b = pixels[index + 2]!;
            const alpha = pixels[index + 3]!;
            const score = colorDistanceScoreFromPoint(0, 0, r, g, b, alpha);
            if (score === null) {
                continue;
            }
            const color = nearestAnnotationSwatch(r, g, b);
            counts.set(color, (counts.get(color) ?? 0) + 1);
        }
    }

    let bestColor: string | null = null;
    let bestCount = 0;
    for (const [
        color,
        count,
    ] of counts) {
        if (count > bestCount) {
            bestColor = color;
            bestCount = count;
        }
    }
    return bestColor;
}

function recolorCanvasTextMarkupPixelsInRect(
    canvas: HTMLCanvasElement,
    pageContainer: HTMLElement,
    targetRect: IAnnotationMarkerRect,
    color: string,
    subtype: string,
    sourceColor: string | null = null,
) {
    const targetColor = parseCssRgbColor(color);
    if (!targetColor) {
        return false;
    }
    const sourceRgb = sourceColor ? parseCssRgbColor(sourceColor) : null;
    const sourceSwatch = sourceRgb ? nearestAnnotationSwatch(sourceRgb.r, sourceRgb.g, sourceRgb.b) : null;

    const canvasRect = canvas.getBoundingClientRect();
    const pageRect = pageContainer.getBoundingClientRect();
    if (
        canvasRect.width <= 0
        || canvasRect.height <= 0
        || pageRect.width <= 0
        || pageRect.height <= 0
    ) {
        return false;
    }

    const viewportLeft = pageRect.left + targetRect.left * pageRect.width;
    const viewportTop = pageRect.top + targetRect.top * pageRect.height;
    const viewportWidth = targetRect.width * pageRect.width;
    const viewportHeight = targetRect.height * pageRect.height;
    const sampleLeft = Math.max(canvasRect.left, viewportLeft);
    const sampleTop = Math.max(canvasRect.top, viewportTop);
    const sampleRight = Math.min(canvasRect.right, viewportLeft + viewportWidth);
    const sampleBottom = Math.min(canvasRect.bottom, viewportTop + viewportHeight);
    if (sampleRight <= sampleLeft || sampleBottom <= sampleTop) {
        return false;
    }

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        return false;
    }

    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    const left = Math.max(0, Math.floor((sampleLeft - canvasRect.left) * scaleX));
    const top = Math.max(0, Math.floor((sampleTop - canvasRect.top) * scaleY));
    const right = Math.min(canvas.width, Math.ceil((sampleRight - canvasRect.left) * scaleX));
    const bottom = Math.min(canvas.height, Math.ceil((sampleBottom - canvasRect.top) * scaleY));
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) {
        return false;
    }

    let data: ImageData;
    try {
        data = context.getImageData(left, top, width, height);
    } catch {
        return false;
    }

    const pixels = data.data;
    const isAnnotationPixel = (pixelIndex: number) => {
        const r = pixels[pixelIndex]!;
        const g = pixels[pixelIndex + 1]!;
        const b = pixels[pixelIndex + 2]!;
        const alpha = pixels[pixelIndex + 3]!;
        return colorDistanceScoreFromPoint(0, 0, r, g, b, alpha) !== null;
    };
    const lineBand = (() => {
        if (subtype === 'strikeout' || subtype === 'strikethrough') {
            return {
                end: Math.max(1, Math.ceil(height * 0.7)),
                start: Math.max(0, Math.floor(height * 0.3)),
            };
        }
        if (subtype === 'underline') {
            return {
                end: height,
                start: Math.max(0, Math.floor(height * 0.55)),
            };
        }
        return {
            end: height,
            start: 0,
        };
    })();
    const inferredSourceSwatch = (() => {
        if (subtype === 'highlight' || sourceSwatch) {
            return sourceSwatch;
        }
        const counts = new Map<string, number>();
        for (let y = lineBand.start; y < lineBand.end; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const index = (y * width + x) * 4;
                if (!isAnnotationPixel(index)) {
                    continue;
                }
                const swatch = nearestAnnotationSwatch(
                    pixels[index]!,
                    pixels[index + 1]!,
                    pixels[index + 2]!,
                );
                counts.set(swatch, (counts.get(swatch) ?? 0) + 1);
            }
        }
        let bestSwatch: string | null = null;
        let bestCount = 0;
        counts.forEach((count, swatch) => {
            if (count > bestCount) {
                bestSwatch = swatch;
                bestCount = count;
            }
        });
        return bestSwatch;
    })();
    const isLikelyLinePixel = (pixelOffset: number) => {
        if (subtype === 'highlight') {
            return true;
        }
        const currentSwatch = nearestAnnotationSwatch(
            pixels[pixelOffset]!,
            pixels[pixelOffset + 1]!,
            pixels[pixelOffset + 2]!,
        );
        if (inferredSourceSwatch && currentSwatch !== inferredSourceSwatch) {
            return false;
        }
        const x = (pixelOffset / 4) % width;
        const y = Math.floor((pixelOffset / 4) / width);
        if (y < lineBand.start || y >= lineBand.end) {
            return false;
        }
        let sameSwatchRun = 1;
        for (let above = y - 1; above >= 0; above -= 1) {
            const aboveIndex = (above * width + x) * 4;
            if (!isAnnotationPixel(aboveIndex)) {
                break;
            }
            if (nearestAnnotationSwatch(pixels[aboveIndex]!, pixels[aboveIndex + 1]!, pixels[aboveIndex + 2]!) === currentSwatch) {
                sameSwatchRun += 1;
            }
        }
        for (let below = y + 1; below < height; below += 1) {
            const belowIndex = (below * width + x) * 4;
            if (!isAnnotationPixel(belowIndex)) {
                break;
            }
            if (nearestAnnotationSwatch(pixels[belowIndex]!, pixels[belowIndex + 1]!, pixels[belowIndex + 2]!) === currentSwatch) {
                sameSwatchRun += 1;
            }
        }
        if (!inferredSourceSwatch && sameSwatchRun >= 2) {
            return false;
        }
        return true;
    };

    let recoloredPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
        if (!isAnnotationPixel(index) || !isLikelyLinePixel(index)) {
            continue;
        }
        pixels[index] = targetColor.r;
        pixels[index + 1] = targetColor.g;
        pixels[index + 2] = targetColor.b;
        recoloredPixels += 1;
    }
    if (recoloredPixels === 0) {
        return false;
    }
    context.putImageData(data, left, top);
    return true;
}

function resolvePageContainerAtPoint(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    clientX: number,
    clientY: number,
) {
    return findPageContainers(container, comment, [])
        .find((pageContainer) => {
            const rect = pageContainer.getBoundingClientRect();
            return clientX >= rect.left
                && clientX <= rect.right
                && clientY >= rect.top
                && clientY <= rect.bottom;
        })
        ?? container.ownerDocument.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('.page_container')
        ?? null;
}

function readCanvasTextMarkupColorAtPoint(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    clientX: number,
    clientY: number,
) {
    const pageContainer = resolvePageContainerAtPoint(container, comment, clientX, clientY);
    if (!pageContainer || !container.contains(pageContainer)) {
        return null;
    }
    for (const canvas of pageContainer.querySelectorAll<HTMLCanvasElement>('canvas')) {
        const color = sampleCanvasTextMarkupColorAtPoint(canvas, clientX, clientY);
        if (color) {
            return color;
        }
    }
    return null;
}

function readCanvasTextMarkupColorAtPointResult(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    clientX: number,
    clientY: number,
): ITextMarkupColorResolutionDiagnostics | null {
    const color = readCanvasTextMarkupColorAtPoint(container, comment, clientX, clientY);
    return color
        ? {
            annotationId: comment.annotationId ?? null,
            color,
            element: 'canvas',
            pageNumber: comment.pageNumber ?? null,
            source: 'canvas',
            subtype: normalizeTextMarkupSubtype(comment.subtype),
        }
        : null;
}

function readCanvasTextMarkupColorForCommentResult(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
): ITextMarkupColorResolutionDiagnostics | null {
    const annotationElements = comment.annotationId
        ? collectMatchingAnnotationElements(container, comment.annotationId)
        : [];
    const subtype = normalizeTextMarkupSubtype(comment.subtype);
    for (const pageContainer of findPageContainers(container, comment, annotationElements)) {
        const targetRects = getTargetRects(pageContainer, comment, annotationElements);
        for (const canvas of pageContainer.querySelectorAll<HTMLCanvasElement>('canvas')) {
            for (const targetRect of targetRects) {
                const color = sampleCanvasTextMarkupColorInRect(canvas, pageContainer, targetRect);
                if (color) {
                    return {
                        annotationId: comment.annotationId ?? null,
                        color,
                        element: 'canvas',
                        pageNumber: comment.pageNumber ?? null,
                        source: 'canvas',
                        subtype,
                    };
                }
            }
        }
    }
    return null;
}

function resolveAnnotationCommentTextMarkupColorWithDiagnostics(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
): ITextMarkupColorResolutionDiagnostics {
    if (!isTextMarkupSubtype(comment.subtype)) {
        return {
            annotationId: comment.annotationId ?? null,
            color: null,
            element: null,
            pageNumber: comment.pageNumber ?? null,
            source: 'not-text-markup',
            subtype: comment.subtype ?? null,
        };
    }
    const annotationId = comment.annotationId;
    const annotationElements = annotationId ? collectMatchingAnnotationElements(container, annotationId) : [];
    collectGeometryMatchedTextMarkupElements(container, comment)
        .forEach(element => appendUniqueElement(annotationElements, element));
    const subtype = normalizeTextMarkupSubtype(comment.subtype);

    for (const element of annotationElements) {
        const result = readElementTextMarkupColorResult(element, subtype);
        if (result) {
            return {
                annotationId: comment.annotationId ?? null,
                color: result.color,
                element: result.element,
                pageNumber: comment.pageNumber ?? null,
                source: result.source === 'element' ? 'summary:element' : 'summary:visual-node',
                subtype,
            };
        }
    }

    for (const pageContainer of findPageContainers(container, comment, annotationElements)) {
        for (const candidate of collectMatchingHighlightVisuals(
            pageContainer,
            getTargetRects(pageContainer, comment, annotationElements),
        )) {
            const result = readElementTextMarkupColorResult(candidate.svg, subtype);
            if (result) {
                return {
                    annotationId: comment.annotationId ?? null,
                    color: result.color,
                    element: result.element,
                    pageNumber: comment.pageNumber ?? null,
                    source: result.source === 'element' ? 'visual:element' : 'visual:visual-node',
                    subtype,
                };
            }
        }
    }

    return {
        annotationId: comment.annotationId ?? null,
        color: null,
        element: null,
        pageNumber: comment.pageNumber ?? null,
        source: 'fallback:none',
        subtype,
    };
}

export function resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    clientX: number,
    clientY: number,
): ITextMarkupColorResolutionDiagnostics {
    if (!isTextMarkupSubtype(comment.subtype)) {
        return {
            annotationId: comment.annotationId ?? null,
            color: null,
            element: null,
            pageNumber: comment.pageNumber ?? null,
            source: 'not-text-markup',
            subtype: comment.subtype ?? null,
        };
    }
    const subtype = normalizeTextMarkupSubtype(comment.subtype);
    const pointElements = collectTextMarkupElementsFromPoint(container, clientX, clientY);
    if (subtype === 'highlight') {
        const geometryCanvasResult = readCanvasTextMarkupColorForCommentResult(container, comment);
        if (geometryCanvasResult) {
            return {
                ...geometryCanvasResult,
                pointElementCount: pointElements.length,
            };
        }
    }
    if (subtype !== 'highlight') {
        for (const element of collectTextMarkupLineColorElementsNearPoint(
            container,
            comment,
            subtype,
            clientX,
            clientY,
        )) {
            const result = readElementTextMarkupColorResult(element, subtype);
            if (result) {
                return {
                    annotationId: comment.annotationId ?? null,
                    color: result.color,
                    element: result.element,
                    pageNumber: comment.pageNumber ?? null,
                    pointElementCount: pointElements.length,
                    source: result.source === 'element' ? 'point:nearby-element' : 'point:nearby-visual-node',
                    subtype,
                };
            }
        }
        const geometryCanvasResult = readCanvasTextMarkupColorForCommentResult(container, comment);
        if (geometryCanvasResult) {
            return {
                ...geometryCanvasResult,
                pointElementCount: pointElements.length,
            };
        }
    }
    for (const element of pointElements) {
        const result = readElementTextMarkupColorResult(element, subtype);
        if (result) {
            return {
                annotationId: comment.annotationId ?? null,
                color: result.color,
                element: result.element,
                pageNumber: comment.pageNumber ?? null,
                pointElementCount: pointElements.length,
                source: result.source === 'element' ? 'point:element' : 'point:visual-node',
                subtype,
            };
        }
    }
    const canvasResult = readCanvasTextMarkupColorAtPointResult(container, comment, clientX, clientY);
    if (canvasResult) {
        return {
            ...canvasResult,
            pointElementCount: pointElements.length,
        };
    }
    const fallback = resolveAnnotationCommentTextMarkupColorWithDiagnostics(container, comment);
    return {
        ...fallback,
        fallbackSource: fallback.source,
        pointElementCount: pointElements.length,
    };
}

export function resolveAnnotationCommentTextMarkupColorAtPoint(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    clientX: number,
    clientY: number,
) {
    return resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
        container,
        comment,
        clientX,
        clientY,
    ).color;
}

export function resolveAnnotationCommentTextMarkupColor(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
) {
    return resolveAnnotationCommentTextMarkupColorWithDiagnostics(container, comment).color;
}

export function resolveCommentWithRenderedTextMarkupColor(
    container: HTMLElement | null,
    comment: IAnnotationCommentSummary | null,
) {
    if (!container || !comment || !isTextMarkupSubtype(comment.subtype)) {
        return comment;
    }
    if (normalizeTextMarkupSubtype(comment.subtype) === 'highlight' && comment.color?.trim()) {
        return comment;
    }
    const renderedColor = resolveAnnotationCommentTextMarkupColor(container, comment);
    return renderedColor
        ? {
            ...comment,
            color: renderedColor,
        }
        : comment;
}

export function resolveCommentWithRenderedTextMarkupColorAtPoint(
    container: HTMLElement | null,
    comment: IAnnotationCommentSummary | null,
    clientX: number,
    clientY: number,
) {
    if (!container || !comment || !isTextMarkupSubtype(comment.subtype)) {
        return comment;
    }
    if (normalizeTextMarkupSubtype(comment.subtype) === 'highlight' && comment.color?.trim()) {
        return comment;
    }
    const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
        container,
        comment,
        clientX,
        clientY,
    );
    BrowserLogger.debug('annotations', 'Resolved text markup context-menu color', () => ({
        annotationId: diagnostics.annotationId,
        originalColor: comment.color ?? null,
        renderedColor: diagnostics.color,
        source: diagnostics.source,
        fallbackSource: diagnostics.fallbackSource ?? null,
        element: diagnostics.element,
        subtype: diagnostics.subtype,
        pageNumber: diagnostics.pageNumber,
        pointElementCount: diagnostics.pointElementCount ?? null,
    }));
    return diagnostics.color
        ? {
            ...comment,
            color: diagnostics.color,
        }
        : comment;
}

function removeBestMatchingHighlightVisual(
    pageContainer: HTMLElement,
    targetRects: IAnnotationMarkerRect[],
) {
    if (targetRects.length === 0) {
        return false;
    }

    let bestCandidate: IHighlightVisualCandidate | null = null;
    for (const svg of getDrawLayerHighlightSvgs(pageContainer)) {
        const candidate = toHighlightVisualCandidate(pageContainer, svg, targetRects);
        if (!candidate) {
            continue;
        }
        bestCandidate = pickBetterHighlightVisualCandidate(bestCandidate, candidate);
    }

    if (!bestCandidate || !isMatchedHighlightVisual(bestCandidate)) {
        return false;
    }

    const svgToRemove: Element = bestCandidate.svg;
    svgToRemove.remove();
    refreshHighlightCompositeOverlay(pageContainer);
    return true;
}

function isVisiblePaint(value: string | null | undefined) {
    return Boolean(value && value !== 'none' && value !== 'transparent');
}

function suppressSvgFill(svg: SVGElement) {
    let changed = isVisiblePaint(svg.getAttribute('fill'))
        || isVisiblePaint(svg.style.getPropertyValue('fill'));
    svg.setAttribute('fill', 'transparent');
    svg.setAttribute('fill-opacity', '0');
    svg.style.setProperty('fill', 'transparent');
    svg.style.setProperty('fill-opacity', '0');
    svg.querySelectorAll<SVGElement>('path, rect, line, polyline, polygon, use').forEach((node) => {
        if (node.getAttribute('fill') === 'none') {
            return;
        }
        changed = changed
            || isVisiblePaint(node.getAttribute('fill'))
            || isVisiblePaint(node.style.getPropertyValue('fill'));
        node.setAttribute('fill', 'transparent');
        node.setAttribute('fill-opacity', '0');
        node.style.setProperty('fill', 'transparent');
        node.style.setProperty('fill-opacity', '0');
    });
    return changed;
}

function suppressSvgStroke(svg: SVGElement) {
    let changed = isVisiblePaint(svg.getAttribute('stroke'))
        || isVisiblePaint(svg.style.getPropertyValue('stroke'));
    svg.setAttribute('stroke', 'transparent');
    svg.setAttribute('stroke-opacity', '0');
    svg.style.setProperty('stroke', 'transparent');
    svg.style.setProperty('stroke-opacity', '0');
    svg.querySelectorAll<SVGElement>('path, rect, line, polyline, polygon, use').forEach((node) => {
        const stroke = node.getAttribute('stroke');
        if (!stroke || stroke === 'none') {
            return;
        }
        changed = changed
            || isVisiblePaint(stroke)
            || isVisiblePaint(node.style.getPropertyValue('stroke'));
        node.setAttribute('stroke', 'transparent');
        node.setAttribute('stroke-opacity', '0');
        node.style.setProperty('stroke', 'transparent');
        node.style.setProperty('stroke-opacity', '0');
    });
    return changed;
}

function isTextMarkupStrokeNode(node: SVGElement, stroke: string | null | undefined) {
    const tagName = node.tagName.toLowerCase();
    return isVisiblePaint(stroke)
        && (
            tagName === 'line'
            || tagName === 'path'
            || tagName === 'polyline'
        );
}

function hasVisibleSvgFill(svg: SVGElement) {
    if (
        isVisiblePaint(svg.getAttribute('fill'))
        || isVisiblePaint(svg.style.getPropertyValue('fill'))
    ) {
        return true;
    }
    return Array.from(svg.querySelectorAll<SVGElement>('path, rect, line, polyline, polygon, use'))
        .some(node => isVisiblePaint(node.getAttribute('fill'))
            || isVisiblePaint(node.style.getPropertyValue('fill')));
}

function shouldSuppressBaseSubtypeVisual(svg: SVGElement, subtype: string) {
    return subtype !== 'highlight'
        && !isSubtypeDrawStrokeVisualElement(svg)
        && (
            isSubtypeDrawVisualElement(svg)
            || (elementHasClassFragment(svg, 'highlight') && hasVisibleSvgFill(svg))
        );
}

function setSvgPaintColor(svg: SVGElement, color: string, subtype: string) {
    let updated = false;
    if (subtype === 'highlight') {
        svg.setAttribute('fill', color);
        svg.style.setProperty('fill', color);
        updated = true;
    } else {
        if (shouldSuppressBaseSubtypeVisual(svg, subtype)) {
            updated = suppressSvgFill(svg) || updated;
            updated = suppressSvgStroke(svg) || updated;
            svg.style.setProperty('color', color);
            svg.style.setProperty('--pdf-markup-subtype-color', color);
            return updated;
        }
        const rootFill = svg.getAttribute('fill');
        const rootStroke = svg.getAttribute('stroke');
        updated = suppressSvgFill(svg);
        if (!isVisiblePaint(rootFill) && isVisiblePaint(rootStroke)) {
            svg.setAttribute('stroke', color);
            svg.style.setProperty('stroke', color);
            updated = true;
        }
    }
    svg.style.setProperty('color', color);
    svg.style.setProperty('--pdf-markup-subtype-color', color);
    svg.querySelectorAll<SVGElement>('path, rect, line, polyline, polygon, use').forEach((node) => {
        node.style.setProperty('color', color);
        node.style.setProperty('--pdf-markup-subtype-color', color);
        const fill = node.getAttribute('fill');
        const stroke = node.getAttribute('stroke');
        if (subtype !== 'highlight' && !isTextMarkupStrokeNode(node, stroke)) {
            if (fill !== 'none') {
                node.setAttribute('fill', 'transparent');
                node.setAttribute('fill-opacity', '0');
                node.style.setProperty('fill', 'transparent');
                node.style.setProperty('fill-opacity', '0');
            }
            return;
        }
        if (subtype === 'highlight' && (!fill || fill !== 'none')) {
            node.setAttribute('fill', color);
            node.style.setProperty('fill', color);
            updated = true;
        }
        if (subtype !== 'highlight' || (stroke && stroke !== 'none')) {
            node.setAttribute('stroke', color);
            node.style.setProperty('stroke', color);
            updated = true;
        }
    });
    return updated;
}

function recolorMatchingHighlightVisuals(
    pageContainer: HTMLElement,
    targetRects: IAnnotationMarkerRect[],
    color: string,
    subtype: string,
) {
    const candidates = collectMatchingHighlightVisuals(pageContainer, targetRects);
    if (candidates.length === 0) {
        return 0;
    }

    const updatedCount = candidates
        .filter(candidate => setSvgPaintColor(candidate.svg, color, subtype))
        .length;
    if (updatedCount > 0) {
        refreshHighlightCompositeOverlay(pageContainer);
    }
    return updatedCount;
}

function normalizeTextMarkupSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase();
}

function toTextMarkupSubtype(subtype: string | null | undefined): TMarkupSubtype | null {
    const normalized = normalizeTextMarkupSubtype(subtype);
    if (normalized === 'highlight') {
        return 'Highlight';
    }
    if (normalized === 'underline') {
        return 'Underline';
    }
    if (normalized === 'squiggly') {
        return 'Squiggly';
    }
    if (normalized === 'strikeout') {
        return 'StrikeOut';
    }
    return null;
}

function getEditedTextMarkupVisualKey(comment: IAnnotationCommentSummary) {
    return normalizePdfJsAnnotationId(comment.annotationId ?? comment.uid ?? comment.id)
        ?? comment.stableKey
        ?? comment.id;
}

function formatOverlayNumber(value: number) {
    const normalized = Math.abs(value) < 0.000001 ? 0 : value;
    if (Number.isInteger(normalized)) {
        return String(normalized);
    }
    return normalized
        .toFixed(6)
        .replace(/0+$/u, '')
        .replace(/\.$/u, '');
}

function normalizeEditedHighlightOverlayOpacity(value: number | null | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_EDITED_HIGHLIGHT_OVERLAY_OPACITY;
    }
    return Math.min(1, Math.max(0, value));
}

function normalizeComparableColor(value: string | null | undefined) {
    const parsed = parseCssRgbColor(value);
    return parsed ? rgbToHex(parsed).toLowerCase() : (value?.trim().toLowerCase() ?? '');
}

function normalizeEditedHighlightOverlayColor(color: string, opacity: number) {
    const normalizedColor = normalizeComparableColor(color);
    const matchingRawSwatch = ANNOTATION_COLOR_SWATCHES.find((swatch) => (
        normalizeComparableColor(toOpaqueHighlightDisplayColor(swatch, opacity)) === normalizedColor
    ));
    return matchingRawSwatch ?? color;
}

function hasLiveHighlightEditorMatchingRect(pageContainer: HTMLElement, rect: IAnnotationMarkerRect) {
    const editorLayer = pageContainer.querySelector<HTMLElement>('.annotationEditorLayer');
    if (!editorLayer) {
        return false;
    }
    const editorDivs = editorLayer.querySelectorAll<HTMLElement>(':scope > .highlightEditor');
    if (editorDivs.length === 0) {
        return false;
    }
    const layerRect = editorLayer.getBoundingClientRect();
    if (layerRect.width <= 0 || layerRect.height <= 0) {
        return false;
    }
    const tolerance = 0.01;
    for (const div of editorDivs) {
        const r = div.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) {
            continue;
        }
        const nLeft = (r.left - layerRect.left) / layerRect.width;
        const nTop = (r.top - layerRect.top) / layerRect.height;
        const nWidth = r.width / layerRect.width;
        const nHeight = r.height / layerRect.height;
        if (
            Math.abs(nLeft - rect.left) < tolerance
            && Math.abs(nTop - rect.top) < tolerance
            && Math.abs(nWidth - rect.width) < tolerance
            && Math.abs(nHeight - rect.height) < tolerance
        ) {
            return true;
        }
    }
    return false;
}

function createLineOverlayPath(rect: IAnnotationMarkerRect, yRatio: number) {
    const y = rect.top + rect.height * yRatio;
    return [
        `M ${formatOverlayNumber(rect.left)} ${formatOverlayNumber(y)}`,
        `L ${formatOverlayNumber(rect.left + rect.width)} ${formatOverlayNumber(y)}`,
    ].join(' ');
}

function createSquigglyOverlayPath(rect: IAnnotationMarkerRect) {
    const amplitude = Math.max(rect.height * 0.09, 0.001);
    const baseline = rect.top + rect.height * 0.84;
    const step = Math.max(rect.height * 0.16, rect.width / 28, 0.002);
    let x = rect.left;
    let up = true;
    const right = rect.left + rect.width;
    const commands = [`M ${formatOverlayNumber(x)} ${formatOverlayNumber(baseline - amplitude)}`];

    while (x < right) {
        x = Math.min(right, x + step);
        commands.push(`L ${formatOverlayNumber(x)} ${formatOverlayNumber(up ? baseline + amplitude : baseline - amplitude)}`);
        up = !up;
    }

    return commands.join(' ');
}

function createTextMarkupOverlayPath(subtype: TMarkupSubtype, rect: IAnnotationMarkerRect) {
    if (subtype === 'Underline') {
        return createLineOverlayPath(rect, 1);
    }
    if (subtype === 'StrikeOut') {
        return createLineOverlayPath(rect, 0.52);
    }
    if (subtype === 'Squiggly') {
        return createSquigglyOverlayPath(rect);
    }
    return null;
}

function getEditedTextMarkupOverlayHost(pageContainer: HTMLElement) {
    return pageContainer.querySelector<HTMLElement>('.page_canvas, .canvasWrapper') ?? pageContainer;
}

function getEditedTextMarkupOverlayRoot(pageContainer: HTMLElement) {
    const host = getEditedTextMarkupOverlayHost(pageContainer);
    return host.querySelector<SVGSVGElement>(EDITED_TEXT_MARKUP_OVERLAY_SELECTOR);
}

function ensureEditedTextMarkupOverlayRoot(pageContainer: HTMLElement) {
    const existing = getEditedTextMarkupOverlayRoot(pageContainer);
    if (existing) {
        return existing;
    }

    const host = getEditedTextMarkupOverlayHost(pageContainer);
    const root = pageContainer.ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
    host.style.setProperty('position', 'relative');
    root.setAttribute('class', EDITED_TEXT_MARKUP_OVERLAY_CLASS);
    root.setAttribute('data-evb-edited-text-markup-overlay', 'true');
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('focusable', 'false');
    root.setAttribute('viewBox', '0 0 1 1');
    root.setAttribute('preserveAspectRatio', 'none');
    root.style.setProperty('position', 'absolute');
    root.style.setProperty('inset', '0');
    root.style.setProperty('width', '100%');
    root.style.setProperty('height', '100%');
    root.style.setProperty('overflow', 'visible');
    root.style.setProperty('pointer-events', 'none');
    root.style.setProperty('z-index', '3');
    host.append(root);
    return root;
}

function removeEditedTextMarkupOverlayRootIfEmpty(root: SVGSVGElement) {
    if (root.querySelectorAll(`.${EDITED_TEXT_MARKUP_VISUAL_CLASS}`).length === 0) {
        root.remove();
    }
}

function removeEditedTextMarkupOverlayVisual(root: SVGSVGElement, key: string) {
    root
        .querySelectorAll<SVGGElement>(`.${EDITED_TEXT_MARKUP_VISUAL_CLASS}`)
        .forEach((visual) => {
            if (visual.getAttribute(EDITED_TEXT_MARKUP_VISUAL_KEY_ATTR) === key) {
                visual.remove();
            }
        });
}

function appendEditedTextMarkupOverlayVisual(
    root: SVGSVGElement,
    comment: IAnnotationCommentSummary,
    color: string,
    subtype: TMarkupSubtype,
    rect: IAnnotationMarkerRect,
    options: IEditedTextMarkupVisualOptions = {},
) {
    const key = getEditedTextMarkupVisualKey(comment);
    removeEditedTextMarkupOverlayVisual(root, key);

    const visual = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
    visual.setAttribute('class', `${EDITED_TEXT_MARKUP_VISUAL_CLASS} ${EDITED_TEXT_MARKUP_VISUAL_CLASS}--${subtype.toLowerCase()}`);
    visual.setAttribute(EDITED_TEXT_MARKUP_VISUAL_KEY_ATTR, key);
    if (comment.annotationId) {
        visual.setAttribute('data-annotation-id', comment.annotationId);
    }
    visual.style.setProperty('pointer-events', 'none');

    if (subtype === 'Highlight') {
        const highlightOpacity = normalizeEditedHighlightOverlayOpacity(options.highlightOpacity);
        const highlightColor = normalizeEditedHighlightOverlayColor(color, highlightOpacity);
        const highlightRect = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'rect');
        highlightRect.setAttribute('x', formatOverlayNumber(rect.left));
        highlightRect.setAttribute('y', formatOverlayNumber(rect.top));
        highlightRect.setAttribute('width', formatOverlayNumber(rect.width));
        highlightRect.setAttribute('height', formatOverlayNumber(rect.height));
        highlightRect.setAttribute('fill', highlightColor);
        highlightRect.setAttribute('fill-opacity', formatOverlayNumber(highlightOpacity));
        highlightRect.style.setProperty('mix-blend-mode', 'multiply');
        visual.append(highlightRect);
    } else {
        const path = createTextMarkupOverlayPath(subtype, rect);
        if (!path) {
            return false;
        }
        const strokeWidth = EDITED_TEXT_MARKUP_STROKE_WIDTHS[subtype];
        const stroke = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'path');
        stroke.setAttribute('d', path);
        stroke.setAttribute('fill', 'none');
        stroke.setAttribute('stroke', color);
        stroke.setAttribute('stroke-opacity', '1');
        stroke.setAttribute('stroke-linecap', subtype === 'Squiggly' ? 'round' : 'butt');
        stroke.setAttribute('stroke-linejoin', subtype === 'Squiggly' ? 'round' : 'miter');
        stroke.setAttribute('stroke-width', strokeWidth);
        stroke.setAttribute('vector-effect', 'non-scaling-stroke');
        stroke.style.setProperty('stroke', color);
        stroke.style.setProperty('stroke-width', strokeWidth);
        visual.append(stroke);
    }

    root.append(visual);
    return true;
}

function suppressNativeTextMarkupDecorationElement(element: HTMLElement, color: string) {
    element.style.setProperty('--pdf-markup-subtype-color', color);
    element.dataset.markupSubtypeColor = 'true';
    element.style.textDecorationColor = color;
    element.style.borderBottomColor = color;
    element.style.borderTopColor = color;
    element.style.setProperty('text-decoration-line', 'none', 'important');
    element.style.setProperty('text-decoration', 'none', 'important');
    element.style.setProperty('border-bottom-style', 'none', 'important');
    element.style.setProperty('border-top-style', 'none', 'important');
}

function suppressNativeHighlightVisualElement(element: HTMLElement, color: string) {
    element.style.setProperty('--pdf-markup-subtype-color', color);
    element.dataset.markupSubtypeColor = 'true';
    element.style.setProperty('background', 'transparent', 'important');
    element.style.setProperty('background-color', 'transparent', 'important');
    element.style.setProperty('box-shadow', 'none', 'important');
}

function suppressNativeHighlightPaintElement(element: SVGElement) {
    element.style.setProperty('fill', 'transparent', 'important');
    element.style.setProperty('fill-opacity', '0', 'important');
    element.setAttribute('fill', 'transparent');
    element.setAttribute('fill-opacity', '0');
}

function suppressNativeTextMarkupAnnotationLayerVisuals(
    pageContainer: HTMLElement,
    comment: IAnnotationCommentSummary,
    subtype: TMarkupSubtype,
    color: string,
) {
    const annotationElements = comment.annotationId
        ? collectMatchingAnnotationElements(pageContainer, comment.annotationId)
        : [];
    collectGeometryMatchedTextMarkupElements(pageContainer, comment)
        .forEach(element => appendUniqueElement(annotationElements, element));
    if (subtype === 'Highlight') {
        annotationElements.forEach((element) => {
            suppressNativeHighlightVisualElement(element, color);
            element
                .querySelectorAll<HTMLElement>('.overlaidText, mark')
                .forEach(node => suppressNativeHighlightVisualElement(node, color));
            element
                .querySelectorAll<SVGElement>('svg, path, line, rect, polyline, polygon')
                .forEach(suppressNativeHighlightPaintElement);
        });
        return;
    }

    annotationElements.forEach((element) => {
        suppressNativeTextMarkupDecorationElement(element, color);
        element
            .querySelectorAll<HTMLElement>('.overlaidText, mark, u, s')
            .forEach(node => suppressNativeTextMarkupDecorationElement(node, color));
    });
}

export function applyAnnotationCommentTextMarkupVisualOverlay(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    color: string,
    options: IEditedTextMarkupVisualOptions = {},
) {
    const subtype = toTextMarkupSubtype(comment.subtype);
    const rect = normalizeMarkerRect(comment.markerRect);
    const normalizedColor = color.trim();
    if (!subtype || !rect || !normalizedColor) {
        return false;
    }

    let updated = false;
    findPageContainers(container, comment, []).forEach((pageContainer) => {
        suppressNativeTextMarkupAnnotationLayerVisuals(pageContainer, comment, subtype, normalizedColor);
        if (subtype === 'Highlight' && hasLiveHighlightEditorMatchingRect(pageContainer, rect)) {
            const existingRoot = getEditedTextMarkupOverlayRoot(pageContainer);
            if (existingRoot) {
                removeEditedTextMarkupOverlayVisual(existingRoot, getEditedTextMarkupVisualKey(comment));
                removeEditedTextMarkupOverlayRootIfEmpty(existingRoot);
            }
            return;
        }
        const root = ensureEditedTextMarkupOverlayRoot(pageContainer);
        updated = appendEditedTextMarkupOverlayVisual(
            root,
            comment,
            normalizedColor,
            subtype,
            rect,
            options,
        ) || updated;
    });
    return updated;
}

export function syncAnnotationCommentTextMarkupVisualOverlays(
    container: HTMLElement,
    comments: readonly IAnnotationCommentSummary[],
    options: {
        pageNumber?: number | undefined;
        resolveColor: (comment: IAnnotationCommentSummary) => string | null;
        resolveHighlightOpacity?: (comment: IAnnotationCommentSummary) => number | null | undefined;
    },
) {
    const commentsByPage = new Map<HTMLElement, IAnnotationCommentSummary[]>();
    const pageContainers = new Set<HTMLElement>();
    if (Number.isFinite(options.pageNumber) && options.pageNumber! > 0) {
        const pageContainer = container.querySelector<HTMLElement>(
            `.page_container[data-page="${Math.floor(options.pageNumber!)}"]`,
        );
        if (pageContainer) {
            pageContainers.add(pageContainer);
        }
    }

    comments.forEach((comment) => {
        if (!comment.colorEdited || !isTextMarkupSubtype(comment.subtype) || !normalizeMarkerRect(comment.markerRect)) {
            return;
        }
        findPageContainers(container, comment, []).forEach((pageContainer) => {
            if (
                Number.isFinite(options.pageNumber)
                && options.pageNumber! > 0
                && Math.floor(comment.pageNumber) !== Math.floor(options.pageNumber!)
            ) {
                return;
            }
            pageContainers.add(pageContainer);
            const pageComments = commentsByPage.get(pageContainer) ?? [];
            pageComments.push(comment);
            commentsByPage.set(pageContainer, pageComments);
        });
    });

    if (!Number.isFinite(options.pageNumber)) {
        container
            .querySelectorAll<SVGSVGElement>(EDITED_TEXT_MARKUP_OVERLAY_SELECTOR)
            .forEach((root) => {
                const pageContainer = root.closest<HTMLElement>('.page_container');
                if (pageContainer) {
                    pageContainers.add(pageContainer);
                }
            });
    }

    let updatedCount = 0;
    pageContainers.forEach((pageContainer) => {
        const pageComments = commentsByPage.get(pageContainer) ?? [];
        const currentKeys = new Set(pageComments.map(getEditedTextMarkupVisualKey));
        const existingRoot = getEditedTextMarkupOverlayRoot(pageContainer);
        if (existingRoot) {
            existingRoot
                .querySelectorAll<SVGGElement>(`.${EDITED_TEXT_MARKUP_VISUAL_CLASS}`)
                .forEach((visual) => {
                    const key = visual.getAttribute(EDITED_TEXT_MARKUP_VISUAL_KEY_ATTR);
                    if (!key || !currentKeys.has(key)) {
                        visual.remove();
                        updatedCount += 1;
                    }
                });
            removeEditedTextMarkupOverlayRootIfEmpty(existingRoot);
        }

        pageComments.forEach((comment) => {
            const color = options.resolveColor(comment)?.trim();
            const subtype = toTextMarkupSubtype(comment.subtype);
            const rect = normalizeMarkerRect(comment.markerRect);
            if (!color || !subtype || !rect) {
                return;
            }
            suppressNativeTextMarkupAnnotationLayerVisuals(pageContainer, comment, subtype, color);
            if (subtype === 'Highlight' && hasLiveHighlightEditorMatchingRect(pageContainer, rect)) {
                return;
            }
            const root = ensureEditedTextMarkupOverlayRoot(pageContainer);
            if (appendEditedTextMarkupOverlayVisual(
                root,
                comment,
                color,
                subtype,
                rect,
                { highlightOpacity: options.resolveHighlightOpacity?.(comment) },
            )) {
                updatedCount += 1;
            }
        });
    });

    return updatedCount;
}

function toCanvasRect(canvas: HTMLCanvasElement, rect: IAnnotationMarkerRect) {
    return {
        left: rect.left * canvas.width,
        top: rect.top * canvas.height,
        width: rect.width * canvas.width,
        height: rect.height * canvas.height,
    };
}

function getCanvasTextMarkupStrokeWidth() {
    return EDITED_TEXT_MARKUP_THUMBNAIL_STROKE_WIDTH;
}

export function drawAnnotationCommentTextMarkupCanvasVisual(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    comment: IAnnotationCommentSummary,
    color: string,
    options: IEditedTextMarkupVisualOptions = {},
) {
    const subtype = toTextMarkupSubtype(comment.subtype);
    const rect = normalizeMarkerRect(comment.markerRect);
    const normalizedColor = color.trim();
    if (!subtype || !rect || !normalizedColor || canvas.width <= 0 || canvas.height <= 0) {
        return false;
    }

    const canvasRect = toCanvasRect(canvas, rect);
    context.save();
    try {
        if (subtype === 'Highlight') {
            const highlightOpacity = normalizeEditedHighlightOverlayOpacity(options.highlightOpacity);
            context.fillStyle = normalizeEditedHighlightOverlayColor(normalizedColor, highlightOpacity);
            context.globalAlpha = highlightOpacity;
            context.globalCompositeOperation = 'multiply';
            context.fillRect(canvasRect.left, canvasRect.top, canvasRect.width, canvasRect.height);
            return true;
        }

        context.beginPath();
        context.strokeStyle = normalizedColor;
        context.globalAlpha = 1;
        context.lineWidth = getCanvasTextMarkupStrokeWidth();
        context.lineCap = subtype === 'Squiggly' ? 'round' : 'butt';
        context.lineJoin = subtype === 'Squiggly' ? 'round' : 'miter';

        if (subtype === 'Underline' || subtype === 'StrikeOut') {
            const y = canvasRect.top + canvasRect.height * (subtype === 'Underline' ? 1 : 0.52);
            context.moveTo(canvasRect.left, y);
            context.lineTo(canvasRect.left + canvasRect.width, y);
        } else {
            const amplitude = Math.max(canvasRect.height * 0.09, 0.75);
            const baseline = canvasRect.top + canvasRect.height * 0.84;
            const step = Math.max(canvasRect.height * 0.16, canvasRect.width / 28, 1.5);
            let x = canvasRect.left;
            let up = true;
            const right = canvasRect.left + canvasRect.width;
            context.moveTo(x, baseline - amplitude);
            while (x < right) {
                x = Math.min(right, x + step);
                context.lineTo(x, up ? baseline + amplitude : baseline - amplitude);
                up = !up;
            }
        }
        context.stroke();
        return true;
    } finally {
        context.restore();
    }
}

function collectGeometryMatchedTextMarkupElements(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
): HTMLElement[] {
    const commentRect = normalizeMarkerRect(comment.markerRect);
    if (!commentRect) {
        return [];
    }

    const matchedCandidates: ITextMarkupElementCandidate[] = [];

    findPageContainers(container, comment, []).forEach((pageContainer) => {
        const candidates = Array.from(pageContainer.querySelectorAll<HTMLElement>('[data-annotation-id]'))
            .filter(isTextMarkupElement);
        candidates.forEach((element) => {
            const elementRect = rectFromElement(pageContainer, element);
            if (!elementRect) {
                return;
            }
            const iou = markerRectIoU(elementRect, commentRect);
            const distance = markerRectCenterDistance(elementRect, commentRect);
            const axisOverlap = rectHasTextMarkupAxisOverlap(elementRect, commentRect);
            const candidate = {
                axisOverlap,
                distance,
                element,
                iou,
            };
            if (
                candidate.iou >= MIN_HIGHLIGHT_VISUAL_IOU
                || candidate.distance <= MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE
                || candidate.axisOverlap
            ) {
                matchedCandidates.push(candidate);
            }
        });
    });

    return matchedCandidates
        .sort((left, right) => (
            right.iou - left.iou
            || Number(right.axisOverlap) - Number(left.axisOverlap)
            || left.distance - right.distance
        ))
        .map(candidate => candidate.element);
}

function applyAnnotationLayerTextMarkupColor(
    element: HTMLElement,
    subtype: string,
    color: string,
    opts: {
        forceVisible: boolean;
        suppressNativeTextMarkupDecoration: boolean;
    },
) {
    const computedStyle = readComputedStyle(element);
    const forceVisible = opts.forceVisible && subtype === 'highlight';
    const hasElementDecoration = subtype !== 'highlight' && (
        (
            computedStyle?.textDecorationLine !== undefined
            && computedStyle.textDecorationLine !== 'none'
            && computedStyle.textDecorationLine.trim().length > 0
        )
        || (
            computedStyle?.borderBottomStyle !== undefined
            && computedStyle.borderBottomStyle !== 'none'
            && computedStyle.borderBottomWidth !== '0px'
        )
        || (
            computedStyle?.borderTopStyle !== undefined
            && computedStyle.borderTopStyle !== 'none'
            && computedStyle.borderTopWidth !== '0px'
        )
    );
    element.style.setProperty('--pdf-markup-subtype-color', color);
    element.dataset.markupSubtypeColor = 'true';
    if (subtype === 'highlight') {
        if (forceVisible) {
            element.style.setProperty('background-color', color);
        } else {
            element.style.removeProperty('background');
            element.style.removeProperty('background-color');
        }
    } else {
        if (opts.suppressNativeTextMarkupDecoration) {
            element.style.setProperty('text-decoration-line', 'none');
            element.style.setProperty('text-decoration', 'none');
            element.style.setProperty('border-bottom-style', 'none');
            element.style.setProperty('border-top-style', 'none');
        }
        if (hasElementDecoration) {
            element.style.textDecorationColor = color;
            if (
                computedStyle?.borderBottomStyle !== undefined
                && computedStyle.borderBottomStyle !== 'none'
                && computedStyle.borderBottomWidth !== '0px'
            ) {
                element.style.borderBottomColor = color;
            }
            if (
                computedStyle?.borderTopStyle !== undefined
                && computedStyle.borderTopStyle !== 'none'
                && computedStyle.borderTopWidth !== '0px'
            ) {
                element.style.borderTopColor = color;
            }
        }
    }
    if (forceVisible) {
        element.style.setProperty('visibility', 'visible', 'important');
        element.style.setProperty('opacity', '1', 'important');
    }
    const textNodes = Array.from(element.querySelectorAll<HTMLElement>('.overlaidText, mark, u, s'));
    textNodes.forEach((node) => {
        node.dataset.markupSubtypeColor = 'true';
        node.style.textDecorationColor = color;
        if (subtype !== 'highlight' && opts.suppressNativeTextMarkupDecoration) {
            node.style.setProperty('text-decoration-line', 'none');
            node.style.setProperty('text-decoration', 'none');
            node.style.setProperty('border-bottom-style', 'none');
            node.style.setProperty('border-top-style', 'none');
        }
        if (forceVisible) {
            node.style.setProperty('visibility', 'visible', 'important');
            node.style.setProperty('opacity', '1', 'important');
        }
        if (subtype === 'highlight') {
            if (forceVisible) {
                node.style.setProperty('background-color', color);
            } else {
                node.style.removeProperty('background');
                node.style.removeProperty('background-color');
            }
        }
    });
    const svgNodes = Array.from(element.querySelectorAll<SVGElement>(
        subtype === 'highlight'
            ? 'svg, path, line, rect, polyline, polygon'
            : 'path, line, polyline, polygon',
    ));
    svgNodes.forEach((node) => {
        node.style.setProperty('color', color);
        node.style.setProperty('--pdf-markup-subtype-color', color);
        if (forceVisible) {
            node.style.setProperty('opacity', '1', 'important');
            node.style.setProperty('visibility', 'visible', 'important');
        }
        const fill = node.getAttribute('fill');
        const stroke = node.getAttribute('stroke');
        if (subtype !== 'highlight' && !isTextMarkupStrokeNode(node, stroke)) {
            if (fill !== 'none') {
                node.style.setProperty('fill', 'transparent');
                node.style.setProperty('fill-opacity', '0');
                node.setAttribute('fill', 'transparent');
                node.setAttribute('fill-opacity', '0');
            }
            return;
        }
        node.style.setProperty('stroke', color);
        node.style.setProperty('stroke-opacity', '1');
        node.setAttribute('stroke', color);
        node.setAttribute('stroke-opacity', '1');
        if (subtype === 'highlight' && (!fill || fill !== 'none')) {
            node.style.setProperty('fill', color);
            node.style.setProperty('fill-opacity', '1');
            node.setAttribute('fill', color);
            node.setAttribute('fill-opacity', '1');
        }
    });
    return subtype === 'highlight'
        || textNodes.length > 0
        || svgNodes.length > 0
        || hasElementDecoration;
}

export function applyAnnotationCommentTextMarkupColor(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    color: string,
    opts: {
        forceVisible?: boolean;
        sourceColor?: string | null;
        suppressNativeTextMarkupDecoration?: boolean;
    } = {},
) {
    const normalizedColor = color.trim();
    if (!normalizedColor || !isTextMarkupSubtype(comment.subtype)) {
        return false;
    }

    const annotationId = comment.annotationId;
    const annotationElements = annotationId ? collectMatchingAnnotationElements(container, annotationId) : [];
    collectGeometryMatchedTextMarkupElements(container, comment)
        .forEach(element => appendUniqueElement(annotationElements, element));
    const subtype = normalizeTextMarkupSubtype(comment.subtype);
    let updated = false;
    const forceVisible = opts.forceVisible !== false;
    const forceAnnotationLayerVisible = forceVisible && subtype === 'highlight';
    const suppressNativeTextMarkupDecoration = opts.suppressNativeTextMarkupDecoration === true
        && subtype !== 'highlight';
    let recoloredElementCount = 0;
    let recoloredVisualCount = 0;
    let recoloredCanvasCount = 0;

    annotationElements.forEach((element) => {
        if (applyAnnotationLayerTextMarkupColor(element, subtype, normalizedColor, {
            forceVisible: forceAnnotationLayerVisible,
            suppressNativeTextMarkupDecoration,
        })) {
            recoloredElementCount += 1;
            updated = true;
        }
    });

    const pageContainers = findPageContainers(container, comment, annotationElements);
    pageContainers.forEach((pageContainer) => {
        const targetRects = getTargetRects(pageContainer, comment, annotationElements);
        const matchedVisualCount = recolorMatchingHighlightVisuals(
            pageContainer,
            targetRects,
            normalizedColor,
            subtype,
        );
        if (matchedVisualCount > 0) {
            recoloredVisualCount += matchedVisualCount;
            updated = true;
        }
        pageContainer
            .querySelectorAll<HTMLCanvasElement>('canvas')
            .forEach((canvas) => {
                targetRects.forEach((targetRect) => {
                    if (recolorCanvasTextMarkupPixelsInRect(
                        canvas,
                        pageContainer,
                        targetRect,
                        normalizedColor,
                        subtype,
                        opts.sourceColor ?? null,
                    )) {
                        recoloredCanvasCount += 1;
                        updated = true;
                    }
                });
            });
    });

    BrowserLogger.debug('annotations', 'Applied text markup DOM color', () => ({
        annotationId: comment.annotationId ?? null,
        stableKey: comment.stableKey,
        subtype,
        color: normalizedColor,
        forceVisible: forceAnnotationLayerVisible,
        annotationElementCount: annotationElements.length,
        pageCount: pageContainers.length,
        recoloredElementCount,
        recoloredVisualCount,
        recoloredCanvasCount,
        updated,
    }));
    return updated;
}

function removeTextMarkupVisuals(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    annotationElements: HTMLElement[],
) {
    if (!shouldRemoveTextMarkupVisual(comment, annotationElements)) {
        return;
    }

    findPageContainers(container, comment, annotationElements).forEach((pageContainer) => {
        removeBestMatchingHighlightVisual(
            pageContainer,
            getTargetRects(pageContainer, comment, annotationElements),
        );
    });
}

export function removeAnnotationCommentDom(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
) {
    const annotationId = comment.annotationId;
    const annotationElements = annotationId ? collectMatchingAnnotationElements(container, annotationId) : [];
    const popupElements = annotationId ? collectRelatedPopupElements(container, annotationId) : [];

    removeTextMarkupVisuals(container, comment, annotationElements);
    annotationElements.forEach(element => element.remove());
    popupElements.forEach(popup => popup.remove());
}
