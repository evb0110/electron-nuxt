import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    isElectronRoutePath,
    resolveInitialDesktopRuntime,
} from '@app/utils/platform';

describe('platform runtime detection', () => {
    it('recognizes the desktop route prefix', () => {
        expect(isElectronRoutePath('/electron')).toBe(true);
        expect(isElectronRoutePath('/electron/workspace')).toBe(true);
        expect(isElectronRoutePath('/')).toBe(false);
        expect(isElectronRoutePath('/workspace')).toBe(false);
    });

    it('uses the route as an SSR hint when electron api is unavailable', () => {
        expect(resolveInitialDesktopRuntime('/electron', false)).toBe(true);
        expect(resolveInitialDesktopRuntime('/', false)).toBe(false);
    });

    it('prefers the actual electron api when present', () => {
        expect(resolveInitialDesktopRuntime('/', true)).toBe(true);
        expect(resolveInitialDesktopRuntime('/electron', true)).toBe(true);
    });
});
