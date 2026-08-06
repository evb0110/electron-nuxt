import type {IScanCleanupNormalizedZonePoint} from '@contracts/scan-cleanup/domain';

const COORDINATE_EPSILON = 1e-9;
const AREA_TWICE_EPSILON = 1e-12;

function cross(
    start: IScanCleanupNormalizedZonePoint,
    end: IScanCleanupNormalizedZonePoint,
    point: IScanCleanupNormalizedZonePoint,
) {
    return (end.xNormalized - start.xNormalized) * (point.yNormalized - start.yNormalized)
        - (end.yNormalized - start.yNormalized) * (point.xNormalized - start.xNormalized);
}

function onSegment(
    start: IScanCleanupNormalizedZonePoint,
    end: IScanCleanupNormalizedZonePoint,
    point: IScanCleanupNormalizedZonePoint,
) {
    return Math.abs(cross(start, end, point)) <= COORDINATE_EPSILON
        && point.xNormalized >= Math.min(start.xNormalized, end.xNormalized) - COORDINATE_EPSILON
        && point.xNormalized <= Math.max(start.xNormalized, end.xNormalized) + COORDINATE_EPSILON
        && point.yNormalized >= Math.min(start.yNormalized, end.yNormalized) - COORDINATE_EPSILON
        && point.yNormalized <= Math.max(start.yNormalized, end.yNormalized) + COORDINATE_EPSILON;
}

function segmentsIntersect(
    a: IScanCleanupNormalizedZonePoint,
    b: IScanCleanupNormalizedZonePoint,
    c: IScanCleanupNormalizedZonePoint,
    d: IScanCleanupNormalizedZonePoint,
) {
    const abC = cross(a, b, c);
    const abD = cross(a, b, d);
    const cdA = cross(c, d, a);
    const cdB = cross(c, d, b);
    if (
        (abC > COORDINATE_EPSILON && abD < -COORDINATE_EPSILON
            || abC < -COORDINATE_EPSILON && abD > COORDINATE_EPSILON)
        && (cdA > COORDINATE_EPSILON && cdB < -COORDINATE_EPSILON
            || cdA < -COORDINATE_EPSILON && cdB > COORDINATE_EPSILON)
    ) {
        return true;
    }
    return Math.abs(abC) <= COORDINATE_EPSILON && onSegment(a, b, c)
        || Math.abs(abD) <= COORDINATE_EPSILON && onSegment(a, b, d)
        || Math.abs(cdA) <= COORDINATE_EPSILON && onSegment(c, d, a)
        || Math.abs(cdB) <= COORDINATE_EPSILON && onSegment(c, d, b);
}

export function scanCleanupSimplePolygonError(
    points: readonly IScanCleanupNormalizedZonePoint[],
) {
    for (let left = 0; left < points.length; left += 1) {
        for (let right = left + 1; right < points.length; right += 1) {
            const dx = points[left]!.xNormalized - points[right]!.xNormalized;
            const dy = points[left]!.yNormalized - points[right]!.yNormalized;
            if (dx * dx + dy * dy <= COORDINATE_EPSILON * COORDINATE_EPSILON) {
                return 'contains duplicate vertices';
            }
        }
    }

    let twiceArea = 0;
    for (let index = 0; index < points.length; index += 1) {
        const current = points[index]!;
        const next = points[(index + 1) % points.length]!;
        twiceArea += current.xNormalized * next.yNormalized
            - next.xNormalized * current.yNormalized;
    }
    if (Math.abs(twiceArea) <= AREA_TWICE_EPSILON) {
        return 'has near-zero area';
    }

    for (let left = 0; left < points.length; left += 1) {
        const leftNext = (left + 1) % points.length;
        for (let right = left + 1; right < points.length; right += 1) {
            const rightNext = (right + 1) % points.length;
            if (left === right || leftNext === right || rightNext === left) {
                continue;
            }
            if (segmentsIntersect(
                points[left]!,
                points[leftNext]!,
                points[right]!,
                points[rightNext]!,
            )) {
                return 'has intersecting or overlapping edges';
            }
        }
    }
    return null;
}

export function assertSimpleScanCleanupPolygon(
    points: readonly IScanCleanupNormalizedZonePoint[],
    label: string,
) {
    const error = scanCleanupSimplePolygonError(points);
    if (error !== null) {
        throw new Error(`invalid scan-cleanup ${label}: ${error}`);
    }
}
