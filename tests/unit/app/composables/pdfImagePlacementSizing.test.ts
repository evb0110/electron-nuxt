import {
    describe,
    expect,
    it,
} from 'vitest';
import { computeInitialImagePlacementDimensions } from '@app/composables/pdf/pdfImagePlacementSizing';

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
});
