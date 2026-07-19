import {
    describe,
    expect,
    it,
} from 'vitest';
import { toCssColor } from '@app/modules/pdf-viewer/engine/annotation-css-utils/toCssColor';

describe('toCssColor', () => {
    it('applies opacity to hex color strings', () => {
        expect(toCssColor('#00bcd4', 0.7)).toBe('rgba(0, 188, 212, 0.7)');
    });

    it('preserves rgba strings that already carry alpha', () => {
        expect(toCssColor('rgba(0, 188, 212, 0.7)', 0.7)).toBe('rgba(0, 188, 212, 0.7)');
    });

    it('clamps opacity for array colors', () => {
        expect(toCssColor([
            0,
            188,
            212,
        ], 1.4)).toBe('rgba(0, 188, 212, 1)');
    });
});
