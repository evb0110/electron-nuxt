import {
    describe,
    expect,
    it,
} from 'vitest';
import {getPrintRuntimePlatform} from '@electron/utils/getPrintRuntimePlatform';

describe('print runtime platform', () => {
    it('reports the current Node platform', () => {
        expect(getPrintRuntimePlatform()).toBe(process.platform);
    });
});
