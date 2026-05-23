import type { IAnnotationMarkerRect } from '@app/types/annotations';
import {
    normalizeMarkerRect,
    toMarkerRectFromPdfRect,
} from '@app/composables/pdf/annotationGeometry';
import type { TPageRotation } from '@app/composables/pdf/annotationGeometry';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';

interface IPdfAnnotationTextPreviewRecord {
    subtype?: string | null | undefined;
    rect?: number[] | null | undefined;
    quadPoints?: ArrayLike<number> | null | undefined;
}

export interface IPdfTextPreviewItem {
    str?: string | null | undefined;
    transform?: number[] | null | undefined;
    width?: number | null | undefined;
    height?: number | null | undefined;
    hasEOL?: boolean | null | undefined;
}

export interface IPdfTextPreviewViewport {
    transform: number[];
    width: number;
    height: number;
    scale?: number | null | undefined;
}

const MAX_PREVIEW_TEXT_LENGTH = 280;
const TARGET_RECT_PADDING = 0.006;
const MIN_RECT_INTERSECTION_RATIO = 0.18;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function hasUsableViewport(viewport: IPdfTextPreviewViewport | null | undefined): viewport is IPdfTextPreviewViewport {
    return Boolean(
        viewport
        && viewport.transform.length >= 6
        && viewport.transform.slice(0, 6).every(isFiniteNumber)
        && viewport.width > 0
        && viewport.height > 0,
    );
}

function matrixTransform(left: number[], right: number[]) {
    return [
        left[0]! * right[0]! + left[2]! * right[1]!,
        left[1]! * right[0]! + left[3]! * right[1]!,
        left[0]! * right[2]! + left[2]! * right[3]!,
        left[1]! * right[2]! + left[3]! * right[3]!,
        left[0]! * right[4]! + left[2]! * right[5]! + left[4]!,
        left[1]! * right[4]! + left[3]! * right[5]! + left[5]!,
    ];
}

function clampPreviewText(text: string) {
    if (text.length <= MAX_PREVIEW_TEXT_LENGTH) {
        return text;
    }
    return `${text.slice(0, MAX_PREVIEW_TEXT_LENGTH - 1).trimEnd()}...`;
}

function joinPreviewSegments(segments: string[]) {
    return clampPreviewText(
        segments
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
    );
}

function toQuadRects(
    quadPoints: ArrayLike<number> | null | undefined,
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation,
) {
    const rects: IAnnotationMarkerRect[] = [];
    if (!quadPoints || quadPoints.length < 8) {
        return rects;
    }

    for (let index = 0; index + 7 < quadPoints.length; index += 8) {
        const xs = [
            quadPoints[index],
            quadPoints[index + 2],
            quadPoints[index + 4],
            quadPoints[index + 6],
        ].filter(isFiniteNumber);
        const ys = [
            quadPoints[index + 1],
            quadPoints[index + 3],
            quadPoints[index + 5],
            quadPoints[index + 7],
        ].filter(isFiniteNumber);
        if (xs.length === 0 || ys.length === 0) {
            continue;
        }

        const rect = toMarkerRectFromPdfRect(
            [
                Math.min(...xs),
                Math.min(...ys),
                Math.max(...xs),
                Math.max(...ys),
            ],
            pageView,
            pageRotation,
        );
        if (rect) {
            rects.push(rect);
        }
    }

    return rects;
}

function resolveAnnotationTargetRects(
    annotation: IPdfAnnotationTextPreviewRecord,
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation,
) {
    const quadRects = toQuadRects(annotation.quadPoints, pageView, pageRotation);
    if (quadRects.length > 0) {
        return quadRects;
    }

    const rect = annotation.rect
        ? toMarkerRectFromPdfRect(annotation.rect, pageView, pageRotation)
        : null;
    return rect ? [rect] : [];
}

function expandMarkerRect(rect: IAnnotationMarkerRect) {
    return normalizeMarkerRect({
        left: rect.left - TARGET_RECT_PADDING,
        top: rect.top - TARGET_RECT_PADDING,
        width: rect.width + TARGET_RECT_PADDING * 2,
        height: rect.height + TARGET_RECT_PADDING * 2,
    }) ?? rect;
}

function rectIntersectionArea(left: IAnnotationMarkerRect, right: IAnnotationMarkerRect) {
    const x1 = Math.max(left.left, right.left);
    const y1 = Math.max(left.top, right.top);
    const x2 = Math.min(left.left + left.width, right.left + right.width);
    const y2 = Math.min(left.top + left.height, right.top + right.height);
    return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function rectArea(rect: IAnnotationMarkerRect) {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function rectsOverlapEnough(textRect: IAnnotationMarkerRect, targetRect: IAnnotationMarkerRect) {
    const intersectionArea = rectIntersectionArea(textRect, expandMarkerRect(targetRect));
    if (intersectionArea <= 0) {
        return false;
    }

    const textArea = rectArea(textRect);
    if (textArea <= 0) {
        return false;
    }

    return intersectionArea / textArea >= MIN_RECT_INTERSECTION_RATIO;
}

function toTextItemMarkerRect(
    item: IPdfTextPreviewItem,
    viewport: IPdfTextPreviewViewport,
) {
    const transform = item.transform;
    if (!transform || transform.length < 6 || !transform.slice(0, 6).every(isFiniteNumber)) {
        return null;
    }

    const tx = matrixTransform(viewport.transform, transform);
    const scale = Math.abs(viewport.scale ?? 1) || 1;
    const fontHeight = Math.max(
        Math.hypot(tx[2]!, tx[3]!),
        Math.abs(item.height ?? 0) * scale,
    );
    const width = Math.abs(item.width ?? 0) * scale;
    if (fontHeight <= 0 || width <= 0) {
        return null;
    }

    return normalizeMarkerRect({
        left: tx[4]! / viewport.width,
        top: (tx[5]! - fontHeight) / viewport.height,
        width: width / viewport.width,
        height: fontHeight / viewport.height,
    });
}

function textItemHitsTarget(
    item: IPdfTextPreviewItem,
    viewport: IPdfTextPreviewViewport,
    targets: IAnnotationMarkerRect[],
) {
    const rect = toTextItemMarkerRect(item, viewport);
    return Boolean(rect && targets.some(target => rectsOverlapEnough(rect, target)));
}

export function resolvePdfAnnotationPreviewText(
    annotation: IPdfAnnotationTextPreviewRecord,
    textItems: readonly IPdfTextPreviewItem[],
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation,
    viewport: IPdfTextPreviewViewport | null | undefined,
) {
    if (!isTextMarkupSubtype(annotation.subtype) || textItems.length === 0 || !hasUsableViewport(viewport)) {
        return null;
    }

    const targets = resolveAnnotationTargetRects(annotation, pageView, pageRotation);
    if (targets.length === 0) {
        return null;
    }

    const segments: string[] = [];
    for (const item of textItems) {
        const text = item.str?.trim();
        if (!text) {
            continue;
        }
        if (textItemHitsTarget(item, viewport, targets)) {
            segments.push(text);
        }
    }

    const previewText = joinPreviewSegments(segments);
    return previewText || null;
}
