import { clamp } from 'es-toolkit/math';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type {
    INormalizedRect,
    IViewportRect,
} from '@app/composables/pdf/annotations/types';
import {
    markerRectIoU,
    mergeMarkerRects,
    normalizeMarkerRect,
    rectsIntersect,
} from '@app/composables/pdf/annotationGeometry';

interface IDetachedMarkerPlacement {
    leftPercent: number;
    topPercent: number;
}

interface IDetachedCommentCluster {
    anchorRect: IAnnotationMarkerRect;
    comments: IAnnotationCommentSummary[];
}

export interface IDetachedMarkerOccupied {
    x: number;
    y: number;
}

interface IDetachedMarkerOffset {
    x: number;
    y: number;
}

const DETACHED_MARKER_OFFSETS: IDetachedMarkerOffset[] = [
    {
        x: 0,
        y: 0, 
    },
    {
        x: 18,
        y: -10, 
    },
    {
        x: 18,
        y: 10, 
    },
    {
        x: -18,
        y: -10, 
    },
    {
        x: -18,
        y: 10, 
    },
    {
        x: 30,
        y: 0, 
    },
    {
        x: 0,
        y: -20, 
    },
    {
        x: 0,
        y: 20, 
    },
    {
        x: 30,
        y: -18, 
    },
    {
        x: 30,
        y: 18, 
    },
    {
        x: -30,
        y: 0, 
    },
    {
        x: 42,
        y: 0, 
    },
    {
        x: -42,
        y: 0, 
    },
    {
        x: 52,
        y: -14, 
    },
    {
        x: 52,
        y: 14, 
    },
    {
        x: -52,
        y: -14, 
    },
    {
        x: -52,
        y: 14, 
    },
];

export function normalizedToViewport(
    pageContainer: HTMLElement,
    rect: INormalizedRect,
): IViewportRect | null {
    const pageRect = pageContainer.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return null;
    }
    return {
        x: pageRect.left + rect.left * pageRect.width,
        y: pageRect.top + rect.top * pageRect.height,
        width: rect.width * pageRect.width,
        height: rect.height * pageRect.height,
    };
}

export function viewportToNormalized(
    pageContainer: HTMLElement,
    viewport: IViewportRect,
): INormalizedRect | null {
    const pageRect = pageContainer.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return null;
    }
    return {
        left: (viewport.x - pageRect.left) / pageRect.width,
        top: (viewport.y - pageRect.top) / pageRect.height,
        width: viewport.width / pageRect.width,
        height: viewport.height / pageRect.height,
    };
}

export function markerRectToPagePixels(
    pageContainer: HTMLElement,
    markerRect: IAnnotationMarkerRect,
): {
    left: number;
    top: number;
    right: number;
    bottom: number 
} | null {
    const pageRect = pageContainer.getBoundingClientRect();
    const width = pageRect.width;
    const height = pageRect.height;
    if (width <= 0 || height <= 0) {
        return null;
    }
    return {
        left: markerRect.left * width,
        top: markerRect.top * height,
        right: (markerRect.left + markerRect.width) * width,
        bottom: (markerRect.top + markerRect.height) * height,
    };
}

export const rectsIntersectLocal = rectsIntersect;

export function pickInlineCommentAnchorTarget(targets: HTMLElement[]) {
    if (targets.length === 0) {
        return null;
    }
    return targets
        .slice()
        .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            if (leftRect.top !== rightRect.top) {
                return leftRect.top - rightRect.top;
            }
            if (leftRect.right !== rightRect.right) {
                return rightRect.right - leftRect.right;
            }
            return leftRect.left - rightRect.left;
        })[0] ?? null;
}

export function clusterDetachedComments(comments: IAnnotationCommentSummary[]) {
    const clusters: IDetachedCommentCluster[] = [];
    comments
        .slice()
        .sort((left, right) => {
            const leftRect = normalizeMarkerRect(left.markerRect);
            const rightRect = normalizeMarkerRect(right.markerRect);
            if (!leftRect || !rightRect) {
                return left.stableKey.localeCompare(right.stableKey);
            }
            if (leftRect.top !== rightRect.top) {
                return leftRect.top - rightRect.top;
            }
            if (leftRect.left !== rightRect.left) {
                return leftRect.left - rightRect.left;
            }
            return left.stableKey.localeCompare(right.stableKey);
        })
        .forEach((comment) => {
            const rect = normalizeMarkerRect(comment.markerRect);
            if (!rect) {
                return;
            }
            const candidate = clusters.find((cluster) => {
                const iou = markerRectIoU(cluster.anchorRect, rect);
                if (iou >= 0.22) {
                    return true;
                }
                const clusterCenterX = cluster.anchorRect.left + cluster.anchorRect.width / 2;
                const clusterCenterY = cluster.anchorRect.top + cluster.anchorRect.height / 2;
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const dx = Math.abs(clusterCenterX - centerX);
                const dy = Math.abs(clusterCenterY - centerY);
                return dx <= 0.028 && dy <= 0.028;
            });
            if (candidate) {
                candidate.comments.push(comment);
                candidate.anchorRect = mergeMarkerRects(candidate.anchorRect, rect);
                return;
            }
            clusters.push({
                anchorRect: rect,
                comments: [comment],
            });
        });
    return clusters;
}

export function resolveDetachedMarkerPlacement(
    pageContainer: HTMLElement,
    markerRect: IAnnotationMarkerRect,
    occupied: IDetachedMarkerOccupied[],
): IDetachedMarkerPlacement {
    const pageRect = pageContainer.getBoundingClientRect();
    const width = pageRect.width;
    const height = pageRect.height;
    if (width <= 0 || height <= 0) {
        return {
            leftPercent: clamp((markerRect.left + markerRect.width) * 100, 1, 99),
            topPercent: clamp(markerRect.top * 100, 1, 99),
        };
    }

    const baseX = (markerRect.left + markerRect.width) * width;
    const baseY = markerRect.top * height;
    const markerRadius = 10;
    const minDistanceSquared = 24 * 24;
    let bestFallback: {
        x: number;
        y: number;
        minDistanceSquared: number 
    } | null = null;

    for (const offset of DETACHED_MARKER_OFFSETS) {
        const x = clamp(baseX + offset.x, markerRadius, width - markerRadius);
        const y = clamp(baseY + offset.y, markerRadius, height - markerRadius);
        const minDistance = occupied.reduce((min, point) => {
            const dx = point.x - x;
            const dy = point.y - y;
            return Math.min(min, dx * dx + dy * dy);
        }, Number.POSITIVE_INFINITY);

        if (minDistance >= minDistanceSquared || occupied.length === 0) {
            occupied.push({
                x,
                y, 
            });
            return {
                leftPercent: (x / width) * 100,
                topPercent: (y / height) * 100,
            };
        }

        if (!bestFallback || minDistance > bestFallback.minDistanceSquared) {
            bestFallback = {
                x,
                y,
                minDistanceSquared: minDistance, 
            };
        }
    }

    const fallbackX = bestFallback?.x ?? clamp(baseX, markerRadius, width - markerRadius);
    const fallbackY = bestFallback?.y ?? clamp(baseY, markerRadius, height - markerRadius);
    occupied.push({
        x: fallbackX,
        y: fallbackY, 
    });
    return {
        leftPercent: (fallbackX / width) * 100,
        topPercent: (fallbackY / height) * 100,
    };
}

export function resolveCommentIndicatorViewportPosition(
    comment: Pick<IAnnotationCommentSummary, 'markerRect' | 'pageNumber'>,
    options: {
        pageContainer?: HTMLElement | null;
        pageRoot?: ParentNode | null;
        fallback?: {
            x: number;
            y: number 
        } | null;
    } = {},
) {
    const markerRect = normalizeMarkerRect(comment.markerRect);
    if (!markerRect) {
        return options.fallback ?? null;
    }
    const pageContainer = options.pageContainer
        ?? options.pageRoot?.querySelector<HTMLElement>(`.page_container[data-page="${comment.pageNumber}"]`)
        ?? null;
    if (!pageContainer) {
        return options.fallback ?? null;
    }

    const pageRect = pageContainer.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return options.fallback ?? null;
    }

    return {
        x: pageRect.left + (markerRect.left + markerRect.width) * pageRect.width,
        y: pageRect.top + markerRect.top * pageRect.height,
    };
}

export type {
    IDetachedMarkerPlacement,
    IDetachedCommentCluster,
};
