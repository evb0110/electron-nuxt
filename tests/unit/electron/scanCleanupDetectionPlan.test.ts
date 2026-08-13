import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolvePreviewProcessingDpi,
    resolvePreviewRasterPlan,
} from '@scan-cleanup-core/detection';

describe('scan cleanup detection raster plan', () => {
    it('keeps source stroke samples for binary preview cleanup', () => {
        expect(resolvePreviewProcessingDpi({
            displayDpi: 150,
            outputMode: 'bw',
            sourceDpi: 300,
        })).toBe(300);
        expect(resolvePreviewProcessingDpi({
            displayDpi: 150,
            outputMode: undefined,
            sourceDpi: 240,
        })).toBe(240);
        expect(resolvePreviewProcessingDpi({
            displayDpi: 150,
            outputMode: 'grayscale',
            sourceDpi: 300,
        })).toBe(150);
        expect(resolvePreviewProcessingDpi({
            displayDpi: 150,
            outputMode: 'mixed',
            sourceDpi: 600,
        })).toBe(300);
    });

    it('uses structural raster DPI when page geometry has no dominant image metadata', () => {
        const plan = resolvePreviewRasterPlan([
            {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 439.6,
                heightPoints: 670,
                rotation: 0,
            },
            {
                pageNumber: 2,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 439.6,
                heightPoints: 670,
                rotation: 0,
            },
        ], new Map([
            [
                1,
                360,
            ],
            [
                2,
                82,
            ],
        ]));

        expect(plan.dpi).toBe(150);
        expect(plan.pageDpiByNumber.get(1)).toBe(360);
        expect(plan.pageDpiByNumber.get(2)).toBe(82);
        expect(plan.detectionDpiByPageNumber.get(1)).toBe(150);
        expect(plan.detectionDpiByPageNumber.get(2)).toBe(82);
    });
});
