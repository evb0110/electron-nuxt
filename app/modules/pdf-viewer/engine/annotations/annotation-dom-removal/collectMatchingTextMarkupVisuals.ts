import type {
    IHighlightVisualCandidate,
    ITextMarkupCandidateContext,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/textMarkupDomRemovalTypes';
import { scoreTextMarkupVisualCandidate } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/scoreTextMarkupVisualCandidate';
import type { IAnnotationMarkerRect } from '@app/types/annotations';

export interface IScoredTextMarkupVisualCandidate extends IHighlightVisualCandidate {matched: boolean;}

const DRAW_LAYER_TEXT_MARKUP_SELECTOR = [
    '.page_canvas svg.highlight:not(.free)',
    '.canvasWrapper svg.highlight:not(.free)',
    '.page_canvas svg.pdf-markup-subtype-draw-visual',
    '.canvasWrapper svg.pdf-markup-subtype-draw-visual',
    '.page_canvas svg[class*="pdf-markup-subtype-draw-visual"]',
    '.canvasWrapper svg[class*="pdf-markup-subtype-draw-visual"]',
    '.annotationLayer section svg',
    '.annotation-layer section svg',
].join(', ');

function getDrawLayerTextMarkupSvgs(pageContainer: HTMLElement) {
    return Array.from(pageContainer.querySelectorAll<SVGElement>(DRAW_LAYER_TEXT_MARKUP_SELECTOR))
        .filter(svg => !svg.classList.contains('pdf-highlight-composite-overlay'));
}

export function scoreTextMarkupSvgCandidate(
    context: ITextMarkupCandidateContext,
    pageContainer: HTMLElement,
    svg: SVGElement,
    targetRects: IAnnotationMarkerRect[],
): IScoredTextMarkupVisualCandidate | null {
    const svgRect = context.getRectForElement(pageContainer, svg);
    if (!svgRect) {
        return null;
    }

    let best: IScoredTextMarkupVisualCandidate | null = null;
    targetRects.forEach((targetRect) => {
        const score = scoreTextMarkupVisualCandidate(svgRect, targetRect);
        const candidate: IScoredTextMarkupVisualCandidate = {
            ...score,
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

export function collectMatchingTextMarkupVisuals(
    context: ITextMarkupCandidateContext,
    pageContainer: HTMLElement,
    targetRects: IAnnotationMarkerRect[],
) {
    if (targetRects.length === 0) {
        return [];
    }

    return getDrawLayerTextMarkupSvgs(pageContainer)
        .map(svg => scoreTextMarkupSvgCandidate(context, pageContainer, svg, targetRects))
        .filter((candidate): candidate is IScoredTextMarkupVisualCandidate => Boolean(candidate?.matched))
        .sort((left, right) => (
            right.iou - left.iou
            || Number(right.axisOverlap) - Number(left.axisOverlap)
            || left.distance - right.distance
        ));
}
