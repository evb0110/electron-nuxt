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
