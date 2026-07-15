import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PACKAGED_DEVTOOLS_MENU_AVAILABLE,
    shouldExposeDevToolsMenu,
} from '@electron/menuDevToolsPolicy';

describe('packaged DevTools menu policy', () => {
    it('keeps renderer diagnostics available in every build', () => {
        expect(PACKAGED_DEVTOOLS_MENU_AVAILABLE).toBe(true);
        expect(shouldExposeDevToolsMenu()).toBe(true);
    });
});
