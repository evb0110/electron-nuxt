import type {
    IHighlightVisualCandidate,
    ITextMarkupCandidateContext,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/textMarkupDomRemovalTypes';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { refreshHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/refreshHighlightCompositeOverlay';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { collectTextMarkupElementCandidates } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/collectTextMarkupElementCandidates';
import { scoreTextMarkupVisualCandidate } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/scoreTextMarkupVisualCandidate';

interface IScoredHighlightVisualCandidate extends IHighlightVisualCandidate {matched: boolean;}

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

function toHighlightVisualCandidate(
    context: ITextMarkupCandidateContext,
    pageContainer: HTMLElement,
    svg: SVGElement,
    targetRects: IAnnotationMarkerRect[],
): IScoredHighlightVisualCandidate | null {
    const svgRect = context.getRectForElement(pageContainer, svg);
    if (!svgRect) {
        return null;
    }

    let best: IScoredHighlightVisualCandidate | null = null;
    targetRects.forEach((targetRect) => {
        const score = scoreTextMarkupVisualCandidate(svgRect, targetRect);
        const candidate: IScoredHighlightVisualCandidate = {
            axisOverlap: score.axisOverlap,
            distance: score.distance,
            iou: score.iou,
            matched: score.matched,
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

function pickBetterHighlightVisualCandidate(
    current: IScoredHighlightVisualCandidate | null,
    candidate: IScoredHighlightVisualCandidate,
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
    context: ITextMarkupCandidateContext,
    pageContainer: HTMLElement,
    targetRects: IAnnotationMarkerRect[],
) {
    if (targetRects.length === 0) {
        return false;
    }

    let bestCandidate: IScoredHighlightVisualCandidate | null = null;
    for (const svg of getDrawLayerHighlightSvgs(pageContainer)) {
        const candidate = toHighlightVisualCandidate(context, pageContainer, svg, targetRects);
        if (!candidate) {
            continue;
        }
        bestCandidate = pickBetterHighlightVisualCandidate(bestCandidate, candidate);
    }

    if (!bestCandidate || !bestCandidate.matched) {
        return false;
    }

    const svgToRemove: Element = bestCandidate.svg;
    svgToRemove.remove();
    refreshHighlightCompositeOverlay(pageContainer);
    return true;
}

function removeTextMarkupVisuals(
    comment: IAnnotationCommentSummary,
    candidates: ITextMarkupCandidateContext,
) {
    if (!shouldRemoveTextMarkupVisual(comment, candidates.annotationElements)) {
        return;
    }

    candidates.pageContexts.forEach((pageContext) => {
        removeBestMatchingHighlightVisual(
            candidates,
            pageContext.pageContainer,
            pageContext.targetRects,
        );
    });
}

export function removeAnnotationCommentDom(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
) {
    const annotationId = comment.annotationId;
    const candidates = collectTextMarkupElementCandidates(container, comment);
    const popupElements = annotationId ? collectRelatedPopupElements(container, annotationId) : [];

    removeTextMarkupVisuals(comment, candidates);
    candidates.annotationElements.forEach(element => element.remove());
    popupElements.forEach(popup => popup.remove());
}
