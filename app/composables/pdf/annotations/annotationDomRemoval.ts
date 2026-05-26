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

const MIN_HIGHLIGHT_VISUAL_IOU = 0.2;
const MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE = 0.025;

interface IHighlightVisualCandidate {
    distance: number;
    iou: number;
    svg: SVGElement;
}

interface ITextMarkupElementCandidate {
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
        '.page_canvas svg.highlight:not(.free), .canvasWrapper svg.highlight:not(.free)',
    )).filter(svg => !svg.classList.contains('pdf-highlight-composite-overlay'));
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
        const candidate: IHighlightVisualCandidate = {
            distance,
            iou,
            svg,
        };
        if (!best || candidate.iou > best.iou || (candidate.iou === best.iou && candidate.distance < best.distance)) {
            best = candidate;
        }
    });

    return best;
}

function isMatchedHighlightVisual(candidate: IHighlightVisualCandidate) {
    return candidate.iou >= MIN_HIGHLIGHT_VISUAL_IOU
        || candidate.distance <= MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE;
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

    for (const svg of getDrawLayerHighlightSvgs(pageContainer)) {
        const candidate = toHighlightVisualCandidate(pageContainer, svg, targetRects);
        if (!candidate || !isMatchedHighlightVisual(candidate)) {
            continue;
        }
        candidates.push(candidate);
    }
    return candidates.sort((left, right) => right.iou - left.iou || left.distance - right.distance);
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

function setSvgPaintColor(svg: SVGElement, color: string) {
    svg.setAttribute('fill', color);
    svg.style.setProperty('fill', color);
    svg.querySelectorAll<SVGElement>('path, rect, line, polyline, polygon').forEach((node) => {
        const fill = node.getAttribute('fill');
        if (!fill || fill !== 'none') {
            node.setAttribute('fill', color);
            node.style.setProperty('fill', color);
        }
        const stroke = node.getAttribute('stroke');
        if (stroke && stroke !== 'none') {
            node.setAttribute('stroke', color);
            node.style.setProperty('stroke', color);
        }
    });
}

function recolorMatchingHighlightVisuals(
    pageContainer: HTMLElement,
    targetRects: IAnnotationMarkerRect[],
    color: string,
) {
    const candidates = collectMatchingHighlightVisuals(pageContainer, targetRects);
    if (candidates.length === 0) {
        return false;
    }

    candidates.forEach(candidate => setSvgPaintColor(candidate.svg, color));
    refreshHighlightCompositeOverlay(pageContainer);
    return true;
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
            const candidate = {
                distance: markerRectCenterDistance(elementRect, commentRect),
                element,
                iou: markerRectIoU(elementRect, commentRect),
            };
            if (
                candidate.iou >= MIN_HIGHLIGHT_VISUAL_IOU
                || candidate.distance <= MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE
            ) {
                matchedCandidates.push(candidate);
            }
        });
    });

    return matchedCandidates
        .sort((left, right) => right.iou - left.iou || left.distance - right.distance)
        .map(candidate => candidate.element);
}

function applyAnnotationLayerTextMarkupColor(
    element: HTMLElement,
    subtype: string,
    color: string,
) {
    element.style.setProperty('--pdf-markup-subtype-color', color);
    if (subtype === 'highlight') {
        element.style.removeProperty('background');
        element.style.removeProperty('background-color');
    } else {
        element.style.color = color;
        element.style.borderColor = color;
        element.style.textDecorationColor = color;
    }
    element.querySelectorAll<HTMLElement>('.overlaidText, mark, u, s').forEach((node) => {
        node.style.color = color;
        node.style.textDecorationColor = color;
        if (subtype === 'highlight') {
            node.style.removeProperty('background');
            node.style.removeProperty('background-color');
        }
    });
    element.querySelectorAll<SVGElement>('svg, path, line, rect, polyline, polygon').forEach((node) => {
        node.style.setProperty('stroke', color);
        if (subtype === 'highlight') {
            node.style.setProperty('fill', color);
        }
    });
}

export function applyAnnotationCommentTextMarkupColor(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    color: string,
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

    annotationElements.forEach((element) => {
        applyAnnotationLayerTextMarkupColor(element, subtype, normalizedColor);
        updated = true;
    });

    findPageContainers(container, comment, annotationElements).forEach((pageContainer) => {
        if (
            recolorMatchingHighlightVisuals(
                pageContainer,
                getTargetRects(pageContainer, comment, annotationElements),
                normalizedColor,
            )
        ) {
            updated = true;
        }
    });

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
