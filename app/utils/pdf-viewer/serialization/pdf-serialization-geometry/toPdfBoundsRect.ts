import { computePointsMinMax } from '@app/utils/pdf-viewer/pdf-page-annotation-iteration/computePointsMinMax';

export function toPdfBoundsRect(points: ReadonlyArray<{
    x: number;
    y: number;
}>, strokeWidth: number) {
    const bounds = computePointsMinMax(points);
    if (!bounds) {
        return null;
    }

    return [
        bounds.minX - strokeWidth,
        bounds.minY - strokeWidth,
        bounds.maxX + strokeWidth,
        bounds.maxY + strokeWidth,
    ] as [number, number, number, number];
}
