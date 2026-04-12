import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    isBrowserPlatformActive,
    isDesktopPlatformActive,
    isElectronRoutePath,
    resolveInitialDesktopRuntime,
    shouldPreferDesktopPlatform,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';

describe('platform runtime detection', () => {
    it('recognizes the desktop route prefix', () => {
        expect(isElectronRoutePath('/electron')).toBe(true);
        expect(isElectronRoutePath('/electron/workspace')).toBe(true);
        expect(isElectronRoutePath('/')).toBe(false);
        expect(isElectronRoutePath('/workspace')).toBe(false);
    });

    it('does not classify the desktop runtime from the route alone', () => {
        expect(resolveInitialDesktopRuntime('/electron', false)).toBe(false);
        expect(resolveInitialDesktopRuntime('/', false)).toBe(false);
    });

    it('prefers the actual electron api when present', () => {
        expect(resolveInitialDesktopRuntime('/', true)).toBe(true);
        expect(resolveInitialDesktopRuntime('/electron', true)).toBe(true);
    });

    it('exposes explicit browser and desktop platform helpers', () => {
        expect(isDesktopPlatformActive(true)).toBe(true);
        expect(isDesktopPlatformActive(false)).toBe(false);
        expect(isBrowserPlatformActive(true)).toBe(false);
        expect(isBrowserPlatformActive(false)).toBe(true);
    });

    it('prefers the desktop platform only when runtime state or the bridge requires it', () => {
        expect(shouldPreferDesktopPlatform('/', true, false)).toBe(true);
        expect(shouldPreferDesktopPlatform('/electron', false, false)).toBe(false);
        expect(shouldPreferDesktopPlatform('/', false, true)).toBe(true);
        expect(shouldPreferDesktopPlatform('/', false, false)).toBe(false);
    });

    it('short-circuits bridge waiting when desktop is not required', async () => {
        await expect(waitForDesktopPlatformBridge({shouldWait: false})).resolves.toBe(false);
    });
});
