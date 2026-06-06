import { rectCenterDistance } from '@app/utils/pdf-viewer/annotation-geometry/rectCenterDistance';
import { rectIoU } from '@app/utils/pdf-viewer/annotation-geometry/rectIoU';

const MAX_HIGHLIGHT_DRAW_LAYER_FALLBACK_DISTANCE = 40;

interface IHighlightDrawLayerCandidate {
    distance: number;
    overlapScore: number;
    svg: SVGElement;
}

function isRenderableRect(rect: DOMRect) {
    return rect.width > 0 && rect.height > 0;
}

function toHighlightDrawLayerCandidate(editorRect: DOMRect, svg: SVGElement): IHighlightDrawLayerCandidate | null {
    const rect = svg.getBoundingClientRect();
    if (!isRenderableRect(rect)) {
        return null;
    }
    const overlapScore = rectIoU(editorRect, rect);
    return {
        distance: overlapScore > 0 ? 0 : rectCenterDistance(editorRect, rect),
        overlapScore,
        svg,
    };
}

function pickBetterHighlightDrawLayerCandidate(
    current: IHighlightDrawLayerCandidate | null,
    candidate: IHighlightDrawLayerCandidate,
) {
    if (!current) {
        return candidate;
    }
    if (current.overlapScore > 0 || candidate.overlapScore > 0) {
        return candidate.overlapScore > current.overlapScore ? candidate : current;
    }
    return candidate.distance < current.distance ? candidate : current;
}

export function findClosestHighlightDrawLayerSvg(pageContainer: HTMLElement, editorDiv: HTMLElement) {
    const editorRect = editorDiv.getBoundingClientRect();
    if (!isRenderableRect(editorRect)) {
        return null;
    }
    const candidates = Array.from(pageContainer.querySelectorAll<SVGElement>('svg.highlight'));
    let bestCandidate: IHighlightDrawLayerCandidate | null = null;

    for (const candidate of candidates) {
        const scoredCandidate = toHighlightDrawLayerCandidate(editorRect, candidate);
        if (!scoredCandidate) {
            continue;
        }
        bestCandidate = pickBetterHighlightDrawLayerCandidate(bestCandidate, scoredCandidate);
    }

    if (
        bestCandidate
        && (
            bestCandidate.overlapScore > 0
            || bestCandidate.distance <= MAX_HIGHLIGHT_DRAW_LAYER_FALLBACK_DISTANCE
        )
    ) {
        return bestCandidate.svg;
    }
    return null;
}
