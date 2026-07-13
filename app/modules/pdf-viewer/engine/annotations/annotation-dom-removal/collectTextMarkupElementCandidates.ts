import type {
    ITextMarkupCandidateContext,
    ITextMarkupElementCandidate,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/textMarkupDomRemovalTypes';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { scoreTextMarkupVisualCandidate } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/scoreTextMarkupVisualCandidate';

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

function isMatchingLiveEditorElement(
    element: HTMLElement,
    comment: IAnnotationCommentSummary,
) {
    if (!element.classList.contains('highlightEditor')) {
        return true;
    }
    const editorIdentity = [
        element.id,
        element.dataset.editorId,
        element.dataset.annotationId,
    ].find(value => Boolean(value));
    if (!editorIdentity) {
        return false;
    }
    return editorIdentity === comment.uid
        || editorIdentity === comment.id;
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

function collectGeometryMatchedTextMarkupElements(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
) {
    const commentRect = normalizeMarkerRect(comment.markerRect);
    if (!commentRect) {
        return [];
    }

    const matchedCandidates: ITextMarkupElementCandidate[] = [];

    findPageContainers(container, comment, []).forEach((pageContainer) => {
        const candidates = Array.from(pageContainer.querySelectorAll<HTMLElement>([
            '[data-annotation-id]',
            '.annotationEditorLayer .highlightEditor',
            '.annotation-editor-layer .highlightEditor',
        ].join(', ')))
            .filter(element => (
                isTextMarkupElement(element)
                && isMatchingLiveEditorElement(element, comment)
            ));
        candidates.forEach((element) => {
            const elementRect = rectFromElement(pageContainer, element);
            if (!elementRect) {
                return;
            }
            const score = scoreTextMarkupVisualCandidate(elementRect, commentRect);
            const candidate = {
                axisOverlap: score.axisOverlap,
                distance: score.distance,
                element,
                iou: score.iou,
            };
            if (score.matched) {
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

export function collectTextMarkupElementCandidates(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
): ITextMarkupCandidateContext {
    const annotationElements = comment.annotationId
        ? collectMatchingAnnotationElements(container, comment.annotationId)
        : [];
    if (annotationElements.length === 0) {
        collectGeometryMatchedTextMarkupElements(container, comment)
            .forEach(element => appendUniqueElement(annotationElements, element));
    }

    return {
        annotationElements,
        getRectForElement: rectFromElement,
        pageContexts: findPageContainers(container, comment, annotationElements)
            .map(pageContainer => ({
                pageContainer,
                targetRects: getTargetRects(pageContainer, comment, annotationElements),
            })),
    };
}
