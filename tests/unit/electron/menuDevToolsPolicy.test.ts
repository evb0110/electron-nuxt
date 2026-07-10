import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PACKAGED_DEVTOOLS_DIAGNOSTICS_ENV,
    shouldExposeDevToolsMenu,
} from '@electron/menuDevToolsPolicy';

describe('packaged DevTools menu policy', () => {
    it('exposes DevTools during development', () => {
        expect(shouldExposeDevToolsMenu(true, undefined)).toBe(true);
    });

    it('hides DevTools in packaged builds by default', () => {
        expect(shouldExposeDevToolsMenu(false, undefined)).toBe(false);
        expect(shouldExposeDevToolsMenu(false, '')).toBe(false);
        expect(shouldExposeDevToolsMenu(false, 'true')).toBe(false);
    });

    it(`requires ${PACKAGED_DEVTOOLS_DIAGNOSTICS_ENV}=1 for packaged diagnostics`, () => {
        expect(shouldExposeDevToolsMenu(false, '1')).toBe(true);
    });
});
