import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IShapeAnnotation } from '@app/types/annotations';
import {
    getResizedBoundsForHandle,
    getShapeBounds,
    resizeShapeToBounds,
} from '@app/composables/pdf/pdfShapeResize';

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
});
