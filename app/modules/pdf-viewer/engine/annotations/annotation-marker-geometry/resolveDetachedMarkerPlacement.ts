import { clamp } from 'es-toolkit/math';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type {
    IDetachedMarkerOccupied,
    IDetachedMarkerPlacement,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-marker-geometry/annotationMarkerGeometryTypes';

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
