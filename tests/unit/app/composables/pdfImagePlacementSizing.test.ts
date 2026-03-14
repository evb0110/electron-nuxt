import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    computeInitialImagePlacementDimensions,
    getImagePlacementResizeCursor,
    getImagePlacementResizeCursorStyle,
    getShortestImagePlacementAngleDelta,
    moveImagePlacementRect,
    resizeImagePlacementRect,
    rotateImagePlacementRect,
    snapImagePlacementRotationDegrees,
} from '@app/composables/pdf/pdfImagePlacementSizing';

describe('computeInitialImagePlacementDimensions', () => {
    it('preserves aspect ratio for wide clipboard images when height minimum cannot be met', () => {
        const dimensions = computeInitialImagePlacementDimensions({
            pageWidthPx: 792,
            pageHeightPx: 1120,
            imageCssWidth: 689,
            imageCssHeight: 164,
        });

        expect(dimensions).not.toBeNull();
        expect(dimensions?.width).toBeCloseTo(0.4, 3);
        expect(dimensions?.height).toBeCloseTo((792 * 0.4 * (164 / 689)) / 1120, 3);
    });

    it('scales small images up uniformly without distorting them', () => {
        const dimensions = computeInitialImagePlacementDimensions({
            pageWidthPx: 800,
            pageHeightPx: 1000,
            imageCssWidth: 50,
            imageCssHeight: 50,
        });

        expect(dimensions).not.toBeNull();
        expect(dimensions?.width).toBeCloseTo(0.15, 3);
        expect(dimensions?.height).toBeCloseTo(0.12, 3);
    });

    it('keeps corner resizing locked to the current aspect ratio', () => {
        const rect = resizeImagePlacementRect({
            originRectPx: {
                left: 120,
                top: 80,
                width: 160,
                height: 80,
            },
            containerRect: {
                width: 800,
                height: 600,
            },
            handle: 'se',
            startClientX: 0,
            startClientY: 0,
            clientX: 48,
            clientY: 12,
        });

        expect(rect.width / rect.height).toBeCloseTo(2, 4);
        expect(rect.width).toBeGreaterThan(160);
        expect(rect.height).toBeGreaterThan(80);
    });

    it('allows side handles to resize a rotated image on a single axis', () => {
        const rect = resizeImagePlacementRect({
            originRectPx: {
                left: 180,
                top: 160,
                width: 140,
                height: 90,
            },
            containerRect: {
                width: 900,
                height: 700,
            },
            handle: 'e',
            startClientX: 0,
            startClientY: 0,
            clientX: 0,
            clientY: 36,
            rotationDegrees: 90,
        });

        expect(rect.width).toBeGreaterThan(140);
        expect(rect.height).toBeCloseTo(90, 4);
    });

    it('snaps rotation near straight angles', () => {
        expect(snapImagePlacementRotationDegrees(2)).toBe(0);
        expect(snapImagePlacementRotationDegrees(88)).toBe(90);
        expect(snapImagePlacementRotationDegrees(182)).toBe(180);
        expect(snapImagePlacementRotationDegrees(44)).toBe(44);
    });

    it('computes a snapped rotation from the rotate handle pointer path', () => {
        const rotated = rotateImagePlacementRect({
            originRectPx: {
                left: 200,
                top: 140,
                width: 120,
                height: 80,
            },
            originRotationDegrees: 0,
            startClientX: 260,
            startClientY: 80,
            clientX: 320,
            clientY: 180,
        });

        expect(rotated.rotationDegrees).toBe(90);
        expect(rotated.rectPx.width).toBeCloseTo(120, 4);
        expect(rotated.rectPx.height).toBeCloseTo(80, 4);
    });

    it('keeps rotation deltas continuous across the angle wrap boundary', () => {
        expect(getShortestImagePlacementAngleDelta(358)).toBeCloseTo(-2, 4);
        expect(getShortestImagePlacementAngleDelta(-358)).toBeCloseTo(2, 4);
    });

    it('rotates resize cursors with the image angle', () => {
        expect(getImagePlacementResizeCursor('n', 0)).toBe('ns-resize');
        expect(getImagePlacementResizeCursor('n', 90)).toBe('ew-resize');
        expect(getImagePlacementResizeCursor('ne', 90)).toBe('nwse-resize');
        expect(getImagePlacementResizeCursor('e', 45)).toBe('nwse-resize');
    });

    it('builds a continuously rotated custom resize cursor style', () => {
        const cursor = getImagePlacementResizeCursorStyle('n', 22.5);

        expect(cursor).toContain('data:image/svg+xml');
        expect(cursor).toContain('rotate(292.5%2016%2016)');
        expect(cursor).toContain('nesw-resize');
    });

    it('keeps rotate drag continuous when crossing the angle wrap boundary', () => {
        const rotated = rotateImagePlacementRect({
            originRectPx: {
                left: 150,
                top: 120,
                width: 100,
                height: 60,
            },
            originRotationDegrees: 15,
            startClientX: 100.152,
            startClientY: 154.792,
            clientX: 101.223,
            clientY: 151.32,
            snapThresholdDegrees: 0,
        });

        expect(rotated.rotationDegrees).toBeCloseTo(17, 1);
    });

    it('keeps moved rotated images inside the page bounds', () => {
        const rect = moveImagePlacementRect({
            originRectPx: {
                left: 220,
                top: 200,
                width: 160,
                height: 100,
            },
            containerRect: {
                width: 500,
                height: 400,
            },
            deltaX: 500,
            deltaY: 0,
            rotationDegrees: 45,
        });

        expect(rect.left + rect.width).toBeLessThanOrEqual(500);
        expect(rect.top).toBeGreaterThanOrEqual(0);
    });
});
