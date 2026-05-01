import {
    describe,
    expect,
    it,
} from 'vitest';
import { regionRectStyle } from '@app/composables/pdf/usePdfRegionSelectionOverlay';

describe('pdf region selection overlay helpers', () => {
    it('formats local rectangles as absolute pixel styles', () => {
        expect(regionRectStyle({
            x: 10,
            y: 20,
            width: 30,
            height: 40,
        })).toEqual({
            left: '10px',
            top: '20px',
            width: '30px',
            height: '40px',
        });
    });

    it('uses an empty style for missing rectangles', () => {
        expect(regionRectStyle(null)).toEqual({});
    });
});
