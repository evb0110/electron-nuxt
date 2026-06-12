import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { markerRectIoU } from '@app/modules/pdf-viewer/engine/annotation-geometry/markerRectIoU';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { markerRectCenterDistance } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/markerRectCenterDistance';
import { refreshHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/refreshHighlightCompositeOverlay';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { BrowserLogger } from '@app/utils/browserLogger';
import { recolorCanvasTextMarkupPixelsInRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/recolorCanvasTextMarkupPixelsInRect';

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

function readComputedStyle(element: Element) {
    try {
        return typeof getComputedStyle === 'function'
            ? getComputedStyle(element)
            : null;
    } catch {
        return null;
    }
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
