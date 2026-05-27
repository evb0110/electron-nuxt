import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
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
} from '@app/composables/pdf/textMarkupColor';
import { BrowserLogger } from '@app/utils/browserLogger';

const MIN_HIGHLIGHT_VISUAL_IOU = 0.2;
const MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE = 0.025;
const TEXT_MARKUP_AXIS_TOLERANCE = 0.018;
const MIN_TEXT_MARKUP_HORIZONTAL_OVERLAP_RATIO = 0.2;
const TEXT_MARKUP_COLOR_OVERRIDE_CLASS = 'pdf-text-markup-color-override';

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

function getTextMarkupColorOverrideKey(comment: IAnnotationCommentSummary) {
    return normalizePdfJsAnnotationId(comment.annotationId)
        ?? comment.stableKey
        ?? comment.id;
}

function removeTextMarkupColorOverrideOverlays(
    pageContainer: HTMLElement,
    comment: IAnnotationCommentSummary,
) {
    const overlayKey = getTextMarkupColorOverrideKey(comment);
    pageContainer.querySelectorAll<SVGElement>(`.${TEXT_MARKUP_COLOR_OVERRIDE_CLASS}`)
        .forEach((overlay) => {
            if (overlay.dataset.annotationKey === overlayKey) {
                overlay.remove();
            }
        });
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
    opts: { forceVisible: boolean },
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
    if (subtype === 'highlight') {
        element.style.removeProperty('background');
        element.style.removeProperty('background-color');
    } else {
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
        node.style.textDecorationColor = color;
        if (forceVisible) {
            node.style.setProperty('visibility', 'visible', 'important');
            node.style.setProperty('opacity', '1', 'important');
        }
        if (subtype === 'highlight') {
            node.style.removeProperty('background');
            node.style.removeProperty('background-color');
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
    opts: { forceVisible?: boolean } = {},
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
    let recoloredElementCount = 0;
    let recoloredVisualCount = 0;

    annotationElements.forEach((element) => {
        if (applyAnnotationLayerTextMarkupColor(element, subtype, normalizedColor, { forceVisible: forceAnnotationLayerVisible })) {
            recoloredElementCount += 1;
            updated = true;
        }
    });

    const pageContainers = findPageContainers(container, comment, annotationElements);
    pageContainers.forEach((pageContainer) => {
        removeTextMarkupColorOverrideOverlays(pageContainer, comment);
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
        removeTextMarkupColorOverrideOverlays(pageContainer, comment);
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
