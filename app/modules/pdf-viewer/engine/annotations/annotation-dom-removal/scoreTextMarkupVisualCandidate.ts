import type { ITextMarkupCandidateScore } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/textMarkupDomRemovalTypes';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { markerRectIoU } from '@app/modules/pdf-viewer/engine/annotation-geometry/markerRectIoU';
import { markerRectCenterDistance } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/markerRectCenterDistance';

const MIN_HIGHLIGHT_VISUAL_IOU = 0.2;

const MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE = 0.025;

const TEXT_MARKUP_AXIS_TOLERANCE = 0.018;

const MIN_TEXT_MARKUP_HORIZONTAL_OVERLAP_RATIO = 0.2;

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

export function scoreTextMarkupVisualCandidate(
    candidateRect: IAnnotationMarkerRect,
    markerRect: IAnnotationMarkerRect,
): ITextMarkupCandidateScore {
    const iou = markerRectIoU(candidateRect, markerRect);
    const distance = markerRectCenterDistance(candidateRect, markerRect);
    const axisOverlap = rectHasTextMarkupAxisOverlap(candidateRect, markerRect);
    return {
        axisOverlap,
        distance,
        iou,
        matched: iou >= MIN_HIGHLIGHT_VISUAL_IOU
            || distance <= MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE
            || axisOverlap,
    };
}
