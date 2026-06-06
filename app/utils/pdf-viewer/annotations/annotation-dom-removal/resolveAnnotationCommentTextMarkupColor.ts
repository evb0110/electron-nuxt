import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { markerRectIoU } from '@app/utils/pdf-viewer/annotation-geometry/markerRectIoU';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';
import { markerRectCenterDistance } from '@app/utils/pdf-viewer/annotations/annotation-rules/markerRectCenterDistance';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { parseCssRgbColor } from '@app/utils/pdf-viewer/text-markup-color/parseCssRgbColor';
import { rgbToHex } from '@app/utils/pdf-viewer/text-markup-color/rgbToHex';
import type { ITextMarkupColorResolutionDiagnostics } from '@app/utils/pdf-viewer/annotations/annotation-dom-removal/textMarkupColorResolutionDiagnostics';

const MIN_HIGHLIGHT_VISUAL_IOU = 0.2;

const MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE = 0.025;

const TEXT_MARKUP_AXIS_TOLERANCE = 0.018;

const MIN_TEXT_MARKUP_HORIZONTAL_OVERLAP_RATIO = 0.2;

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

interface ITextMarkupColorReadResult {
    color: string;
    element: string;
    source: 'element' | 'visual-node';
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

function normalizeTextMarkupSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase();
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

export function resolveAnnotationCommentTextMarkupColor(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
) {
    return resolveAnnotationCommentTextMarkupColorWithDiagnostics(container, comment).color;
}
