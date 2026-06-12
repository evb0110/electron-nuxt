import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { markerRectIoU } from '@app/modules/pdf-viewer/engine/annotation-geometry/markerRectIoU';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { commentsShareStableIdentifier } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity-matching/commentsShareStableIdentifier';

function isTextLikeNoteSubtype(subtype: IAnnotationCommentSummary['subtype']) {
    const normalized = (subtype ?? '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    return (
        normalized.includes('text')
        || normalized.includes('popup')
        || normalized.includes('note')
        || isTextMarkupSubtype(subtype)
    );
}

function intervalOverlap(
    leftStart: number,
    leftEnd: number,
    rightStart: number,
    rightEnd: number,
) {
    return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function rectContainsPoint(
    rect: {
        left: number;
        top: number;
        width: number;
        height: number
    },
    x: number,
    y: number,
) {
    return (
        x >= rect.left
        && x <= rect.left + rect.width
        && y >= rect.top
        && y <= rect.top + rect.height
    );
}

function markerRectLineMirrorSignal(
    left: IAnnotationCommentSummary['markerRect'],
    right: IAnnotationCommentSummary['markerRect'],
) {
    const normalizedLeft = normalizeMarkerRect(left);
    const normalizedRight = normalizeMarkerRect(right);
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }

    const minHeight = Math.max(1e-6, Math.min(normalizedLeft.height, normalizedRight.height));
    const minWidth = Math.max(1e-6, Math.min(normalizedLeft.width, normalizedRight.width));
    const maxWidth = Math.max(normalizedLeft.width, normalizedRight.width);
    const widthRatio = maxWidth / minWidth;

    const yOverlap = intervalOverlap(
        normalizedLeft.top,
        normalizedLeft.top + normalizedLeft.height,
        normalizedRight.top,
        normalizedRight.top + normalizedRight.height,
    ) / minHeight;
    const xOverlap = intervalOverlap(
        normalizedLeft.left,
        normalizedLeft.left + normalizedLeft.width,
        normalizedRight.left,
        normalizedRight.left + normalizedRight.width,
    ) / minWidth;

    const leftCenterX = normalizedLeft.left + normalizedLeft.width / 2;
    const leftCenterY = normalizedLeft.top + normalizedLeft.height / 2;
    const rightCenterX = normalizedRight.left + normalizedRight.width / 2;
    const rightCenterY = normalizedRight.top + normalizedRight.height / 2;
    const centerContainment = rectContainsPoint(normalizedLeft, rightCenterX, rightCenterY)
        || rectContainsPoint(normalizedRight, leftCenterX, leftCenterY);

    return (
        yOverlap >= 0.72
        && (
            centerContainment
            || xOverlap >= 0.18
            || (widthRatio >= 3.2 && xOverlap >= 0.08)
        )
    );
}

function markerRectCenterDistanceLocal(
    left: IAnnotationCommentSummary['markerRect'],
    right: IAnnotationCommentSummary['markerRect'],
) {
    const normalizedLeft = normalizeMarkerRect(left);
    const normalizedRight = normalizeMarkerRect(right);
    if (!normalizedLeft || !normalizedRight) {
        return Number.POSITIVE_INFINITY;
    }
    const leftCx = normalizedLeft.left + normalizedLeft.width / 2;
    const leftCy = normalizedLeft.top + normalizedLeft.height / 2;
    const rightCx = normalizedRight.left + normalizedRight.width / 2;
    const rightCy = normalizedRight.top + normalizedRight.height / 2;
    return Math.hypot(leftCx - rightCx, leftCy - rightCy);
}

interface IEditorPdfMirrorFacts {
    leftText: string;
    rightText: string;
    hasLeftText: boolean;
    hasRightText: boolean;
    hasLeftStableRef: boolean;
    hasRightStableRef: boolean;
    stableRefCount: number;
    iou: number;
    centerDistance: number;
    lineMirror: boolean;
    modifiedClose: boolean;
}

function extractEditorPdfMirrorFacts(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
): IEditorPdfMirrorFacts {
    const leftText = left.text.trim();
    const rightText = right.text.trim();
    const hasLeftStableRef = Boolean(left.annotationId || left.uid);
    const hasRightStableRef = Boolean(right.annotationId || right.uid);
    const leftTs = left.modifiedAt ?? 0;
    const rightTs = right.modifiedAt ?? 0;

    return {
        leftText,
        rightText,
        hasLeftText: leftText.length > 0,
        hasRightText: rightText.length > 0,
        hasLeftStableRef,
        hasRightStableRef,
        stableRefCount: Number(hasLeftStableRef) + Number(hasRightStableRef),
        iou: markerRectIoU(left.markerRect, right.markerRect),
        centerDistance: markerRectCenterDistanceLocal(left.markerRect, right.markerRect),
        lineMirror: markerRectLineMirrorSignal(left.markerRect, right.markerRect),
        modifiedClose: Boolean(leftTs && rightTs && Math.abs(leftTs - rightTs) <= 3_000),
    };
}

function bothTextsPresent(facts: IEditorPdfMirrorFacts) {
    return facts.hasLeftText && facts.hasRightText;
}

function hasStrongSingleStableRefGeometry(facts: IEditorPdfMirrorFacts) {
    return (
        facts.iou >= 0.45
        || facts.centerDistance <= 0.028
        || (facts.lineMirror && facts.centerDistance <= 0.038)
    );
}

function isBothStableRefMirror(facts: IEditorPdfMirrorFacts) {
    if (bothTextsPresent(facts)) {
        return (
            facts.lineMirror
            || facts.iou >= 0.18
            || facts.centerDistance <= 0.08
            || facts.modifiedClose
        );
    }
    if (facts.hasLeftText !== facts.hasRightText) {
        return facts.iou >= 0.62 || facts.centerDistance <= 0.018;
    }
    return facts.modifiedClose && (facts.iou >= 0.28 || facts.centerDistance <= 0.04);
}

function isSingleStableRefMirror(facts: IEditorPdfMirrorFacts) {
    if (!hasStrongSingleStableRefGeometry(facts)) {
        return false;
    }

    if (bothTextsPresent(facts) && facts.leftText !== facts.rightText) {
        return false;
    }

    return facts.modifiedClose || facts.iou >= 0.62 || facts.centerDistance <= 0.018;
}

export function likelyEditorPdfMirror(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }
    if (left.source === right.source) {
        return false;
    }
    if (!(left.hasNote && right.hasNote)) {
        return false;
    }

    const facts = extractEditorPdfMirrorFacts(left, right);
    if (bothTextsPresent(facts) && facts.leftText !== facts.rightText) {
        return false;
    }

    if (!isTextLikeNoteSubtype(left.subtype) || !isTextLikeNoteSubtype(right.subtype)) {
        return false;
    }

    if (commentsShareStableIdentifier(left, right)) {
        return true;
    }

    if (facts.stableRefCount === 0) {
        return false;
    }

    if (facts.hasLeftStableRef && facts.hasRightStableRef) {
        return isBothStableRefMirror(facts);
    }

    return isSingleStableRefMirror(facts);
}
