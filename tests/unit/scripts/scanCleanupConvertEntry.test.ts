import {
    describe,
    expect,
    it,
} from 'vitest';
import {main} from '@scripts/scan-cleanup-convert';

describe('scan-cleanup-convert entry point', () => {
    it('can be imported without starting a conversion', () => {
        expect(main).toBeTypeOf('function');
    });
});
