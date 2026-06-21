import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IShapeAnnotation } from '@app/types/annotations';
import { getPointMinMaxBounds } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/getPointMinMaxBounds';
import { getResizedBoundsForHandle } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/getResizedBoundsForHandle';
import { getShapeBounds } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/getShapeBounds';
import { resizeShapeToBounds } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/resizeShapeToBounds';
import { toShapeRect } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/toShapeRect';

describe('pdfShapeResize', () => {
    it('expands rectangle bounds from the south-east handle', () => {
        const shape: IShapeAnnotation = {
            id: 'shape-rect',
            type: 'rectangle',
            pageIndex: 0,
            x: 0.2,
            y: 0.25,
            width: 0.2,
            height: 0.15,
            color: '#22c55e',
            opacity: 1,
            strokeWidth: 4,
        };

        const baselineBounds = getShapeBounds(shape);
        const nextBounds = getResizedBoundsForHandle(baselineBounds, 'se', {
            x: 0.62,
            y: 0.71,
        });
        const resized = resizeShapeToBounds(shape, baselineBounds, nextBounds);

        expect(resized.x).toBeCloseTo(0.2);
        expect(resized.y).toBeCloseTo(0.25);
        expect(resized.width).toBeCloseTo(0.42);
        expect(resized.height).toBeCloseTo(0.46);
    });

    it('scales line endpoints when resizing from the north-west handle', () => {
        const shape: IShapeAnnotation = {
            id: 'shape-line',
            type: 'line',
            pageIndex: 0,
            x: 0.3,
            y: 0.3,
            x2: 0.6,
            y2: 0.6,
            width: 0.3,
            height: 0.3,
            color: '#3b82f6',
            opacity: 1,
            strokeWidth: 3,
        };

        const baselineBounds = getShapeBounds(shape);
        const nextBounds = getResizedBoundsForHandle(baselineBounds, 'nw', {
            x: 0.1,
            y: 0.2,
        });
        const resized = resizeShapeToBounds(shape, baselineBounds, nextBounds);

        expect(resized.x).toBeCloseTo(0.1);
        expect(resized.y).toBeCloseTo(0.2);
        expect(resized.x2).toBeCloseTo(0.6);
        expect(resized.y2).toBeCloseTo(0.6);
        expect(resized.width).toBeCloseTo(0.5);
        expect(resized.height).toBeCloseTo(0.4);
    });

    it('rescales polygon points and refreshes cached bounds', () => {
        const shape: IShapeAnnotation = {
            id: 'shape-poly',
            type: 'polygon',
            pageIndex: 0,
            x: 0.2,
            y: 0.2,
            width: 0.3,
            height: 0.3,
            color: '#facc15',
            fillColor: '#fde047',
            opacity: 0.9,
            strokeWidth: 4,
            points: [
                {
                    x: 0.2,
                    y: 0.2,
                },
                {
                    x: 0.5,
                    y: 0.2,
                },
                {
                    x: 0.4,
                    y: 0.5,
                },
            ],
        };

        const baselineBounds = getShapeBounds(shape);
        const nextBounds = getResizedBoundsForHandle(baselineBounds, 'se', {
            x: 0.8,
            y: 0.9,
        });
        const resized = resizeShapeToBounds(shape, baselineBounds, nextBounds);

        expect(resized.x).toBeCloseTo(0.2);
        expect(resized.y).toBeCloseTo(0.2);
        expect(resized.width).toBeCloseTo(0.6);
        expect(resized.height).toBeCloseTo(0.7);
        expect(resized.points?.[0]?.x).toBeCloseTo(0.2);
        expect(resized.points?.[0]?.y).toBeCloseTo(0.2);
        expect(resized.points?.[1]?.x).toBeCloseTo(0.8);
        expect(resized.points?.[1]?.y).toBeCloseTo(0.2);
        expect(resized.points?.[2]?.x).toBeCloseTo(0.6);
        expect(resized.points?.[2]?.y).toBeCloseTo(0.9);
    });

    it('keeps resized bounds inside the page and above the minimum size', () => {
        const bounds = getResizedBoundsForHandle({
            minX: 0.25,
            minY: 0.25,
            maxX: 0.45,
            maxY: 0.45,
        }, 'nw', {
            x: 0.9,
            y: 0.95,
        });

        expect(bounds).toEqual({
            minX: 0.44,
            minY: 0.44,
            maxX: 0.45,
            maxY: 0.45,
        });
    });

    it('normalizes inverted baseline bounds before resizing', () => {
        const bounds = getResizedBoundsForHandle({
            minX: 0.7,
            minY: 0.6,
            maxX: 0.2,
            maxY: 0.1,
        }, 'se', {
            x: 0,
            y: 0,
        });

        expect(bounds.minX).toBeCloseTo(0.2);
        expect(bounds.minY).toBeCloseTo(0.1);
        expect(bounds.maxX).toBeCloseTo(0.21);
        expect(bounds.maxY).toBeCloseTo(0.11);
    });

    it('computes min/max bounds from polyline points', () => {
        const shape: IShapeAnnotation = {
            id: 'shape-polyline',
            type: 'polyline',
            pageIndex: 0,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            color: '#0ea5e9',
            opacity: 1,
            strokeWidth: 2,
            points: [
                {
                    x: 0.1,
                    y: 0.4,
                },
                {
                    x: 0.5,
                    y: 0.2,
                },
                {
                    x: 0.3,
                    y: 0.7,
                },
            ],
        };

        const bounds = getShapeBounds(shape);

        expect(bounds).toEqual({
            minX: 0.1,
            minY: 0.2,
            maxX: 0.5,
            maxY: 0.7,
        });
    });

    it('computes min/max bounds from polygon points', () => {
        const points = [
            {
                x: 0.2,
                y: 0.3,
            },
            {
                x: 0.8,
                y: 0.25,
            },
            {
                x: 0.45,
                y: 0.9,
            },
        ];

        expect(getPointMinMaxBounds(points)).toEqual({
            minX: 0.2,
            minY: 0.25,
            maxX: 0.8,
            maxY: 0.9,
        });
    });

    it('returns null bounds for empty point arrays', () => {
        expect(getPointMinMaxBounds([])).toBeNull();
    });

    it('enforces minSize 0.01 for degenerate single-point shapes via toShapeRect', () => {
        const bounds = getPointMinMaxBounds([{
            x: 0.4,
            y: 0.6,
        }]);
        expect(bounds).not.toBeNull();
        const rect = toShapeRect(bounds!, 0.01);

        expect(rect.minX).toBeCloseTo(0.4);
        expect(rect.minY).toBeCloseTo(0.6);
        expect(rect.maxX - rect.minX).toBeCloseTo(0.01);
        expect(rect.maxY - rect.minY).toBeCloseTo(0.01);
    });

    it('enforces minSize 0.0001 for degenerate single-point shapes via toShapeRect', () => {
        const bounds = getPointMinMaxBounds([
            {
                x: 0.5,
                y: 0.5,
            },
            {
                x: 0.5,
                y: 0.5,
            },
        ]);
        expect(bounds).not.toBeNull();
        const rect = toShapeRect(bounds!, 0.0001);

        expect(rect.minX).toBeCloseTo(0.5);
        expect(rect.minY).toBeCloseTo(0.5);
        expect(rect.maxX - rect.minX).toBeCloseTo(0.0001);
        expect(rect.maxY - rect.minY).toBeCloseTo(0.0001);
    });

    it('preserves bounds wider than minSize when calling toShapeRect', () => {
        const rect = toShapeRect({
            minX: 0.1,
            minY: 0.2,
            maxX: 0.6,
            maxY: 0.5,
        }, 0.01);

        expect(rect).toEqual({
            minX: 0.1,
            minY: 0.2,
            maxX: 0.6,
            maxY: 0.5,
        });
    });
});
