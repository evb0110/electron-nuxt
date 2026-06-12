import {
    describe,
    expect,
    it,
} from 'vitest';
import { rectIntersectionArea } from '@app/modules/pdf-viewer/engine/annotation-geometry/rectIntersectionArea';
import { toMarkerRectFromEditorRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromEditorRect';
import type { IAnnotationMarkerRect } from '@app/types/annotations';

function makeDomRect(left: number, top: number, width: number, height: number) {
    return {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({}),
    };
}

describe('rectIntersectionArea', () => {
    it('computes the overlapping area for two partially overlapping rects', () => {
        const a = makeDomRect(0, 0, 10, 10);
        const b = makeDomRect(5, 5, 10, 10);
        expect(rectIntersectionArea(a, b)).toBe(25);
    });

    it('returns zero for disjoint rects positioned side-by-side', () => {
        const a = makeDomRect(0, 0, 10, 10);
        const b = makeDomRect(20, 0, 10, 10);
        expect(rectIntersectionArea(a, b)).toBe(0);
    });

    it('returns zero for rects that only touch along an edge', () => {
        const a = makeDomRect(0, 0, 10, 10);
        const b = makeDomRect(10, 0, 10, 10);
        expect(rectIntersectionArea(a, b)).toBe(0);
    });

    it('returns the smaller rect area when one rect is fully contained', () => {
        const outer = makeDomRect(0, 0, 100, 100);
        const inner = makeDomRect(10, 10, 5, 5);
        expect(rectIntersectionArea(outer, inner)).toBe(25);
    });

    it('returns zero when one of the rects has zero area', () => {
        const a = makeDomRect(0, 0, 0, 10);
        const b = makeDomRect(0, 0, 10, 10);
        expect(rectIntersectionArea(a, b)).toBe(0);
    });

    it('is commutative for overlapping rects', () => {
        const a = makeDomRect(2, 3, 4, 5);
        const b = makeDomRect(3, 4, 5, 6);
        expect(rectIntersectionArea(a, b)).toBe(rectIntersectionArea(b, a));
    });
});

describe('toMarkerRectFromEditorRect', () => {
    // Chosen so that rotation by 90/180/270 still keeps the rect entirely within
    // [0, 1] and avoids the clamp inside normalizeMarkerRect.
    const baseRect: IAnnotationMarkerRect = {
        left: 0.2,
        top: 0.3,
        width: 0.1,
        height: 0.1,
    };

    it('returns null when the input rect is null or undefined', () => {
        expect(toMarkerRectFromEditorRect(null)).toBeNull();
        expect(toMarkerRectFromEditorRect(undefined)).toBeNull();
    });

    it('returns null when width or height are non-positive', () => {
        expect(toMarkerRectFromEditorRect({
            left: 0,
            top: 0,
            width: 0,
            height: 0.1,
        })).toBeNull();
        expect(toMarkerRectFromEditorRect({
            left: 0,
            top: 0,
            width: 0.1,
            height: -1,
        })).toBeNull();
    });

    it('returns the normalized rect unchanged when rotation is 0', () => {
        const result = toMarkerRectFromEditorRect(baseRect, 0);
        expect(result).toEqual(baseRect);
    });

    it('rotates 90 degrees by mapping (left, top) -> (1 - top, left)', () => {
        const result = toMarkerRectFromEditorRect(baseRect, 90);
        expect(result?.left).toBeCloseTo(1 - baseRect.top, 10);
        expect(result?.top).toBeCloseTo(baseRect.left, 10);
        expect(result?.width).toBeCloseTo(baseRect.width, 10);
        expect(result?.height).toBeCloseTo(baseRect.height, 10);
    });

    it('rotates 180 degrees by flipping both axes', () => {
        const result = toMarkerRectFromEditorRect(baseRect, 180);
        expect(result?.left).toBeCloseTo(1 - baseRect.left, 10);
        expect(result?.top).toBeCloseTo(1 - baseRect.top, 10);
        expect(result?.width).toBeCloseTo(baseRect.width, 10);
        expect(result?.height).toBeCloseTo(baseRect.height, 10);
    });

    it('rotates 270 degrees by mapping (left, top) -> (top, 1 - left)', () => {
        const result = toMarkerRectFromEditorRect(baseRect, 270);
        expect(result?.left).toBeCloseTo(baseRect.top, 10);
        expect(result?.top).toBeCloseTo(1 - baseRect.left, 10);
        expect(result?.width).toBeCloseTo(baseRect.width, 10);
        expect(result?.height).toBeCloseTo(baseRect.height, 10);
    });

    it('treats non-finite rotation as 0', () => {
        const result = toMarkerRectFromEditorRect(baseRect, Number.NaN as 0);
        expect(result).toEqual(baseRect);
    });
});
