import {
    describe,
    expect,
    it,
    vi,
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

    it('classifies the desktop runtime from the Electron route before the bridge mounts', () => {
        expect(resolveInitialDesktopRuntime('/electron', false)).toBe(true);
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
        expect(shouldPreferDesktopPlatform('/electron', false, false)).toBe(true);
        expect(shouldPreferDesktopPlatform('/', false, true)).toBe(true);
        expect(shouldPreferDesktopPlatform('/', false, false)).toBe(false);
    });

    it('short-circuits bridge waiting when desktop is not required', async () => {
        await expect(waitForDesktopPlatformBridge({shouldWait: false})).resolves.toBe(false);
    });

    it('does not load the browser platform fallback while an electron api is present', async () => {
        vi.resetModules();
        let browserPlatformImportCount = 0;
        vi.doMock('@app/platform/browserApi', () => {
            browserPlatformImportCount += 1;
            return { browserPlatformApi: { shell: { openExternal: vi.fn().mockResolvedValue(undefined) } } };
        });

        const electronAPI = { shell: { openExternal: vi.fn().mockResolvedValue(undefined) } };
        vi.stubGlobal('window', { electronAPI });

        const { getPlatformAPI } = await import('@app/utils/platform');

        expect(getPlatformAPI()).toBe(electronAPI);
        expect(browserPlatformImportCount).toBe(0);

        vi.unstubAllGlobals();
        vi.doUnmock('@app/platform/browserApi');
    });

    it('loads the browser platform fallback lazily when a browser capability is used', async () => {
        vi.resetModules();
        let browserPlatformImportCount = 0;
        const openExternal = vi.fn().mockResolvedValue(undefined);
        vi.doMock('@app/platform/browserApi', () => {
            browserPlatformImportCount += 1;
            return { browserPlatformApi: { shell: { openExternal } } };
        });
        vi.stubGlobal('window', {});

        const { getPlatformAPI } = await import('@app/utils/platform');

        expect(browserPlatformImportCount).toBe(0);
        await getPlatformAPI().shell.openExternal('https://example.com');
        expect(browserPlatformImportCount).toBe(1);
        expect(openExternal).toHaveBeenCalledWith('https://example.com');

        vi.unstubAllGlobals();
        vi.doUnmock('@app/platform/browserApi');
    });

    it('does not treat lazy browser capabilities as thenables', async () => {
        vi.resetModules();
        vi.stubGlobal('window', {});

        const { getPlatformAPI } = await import('@app/utils/platform');

        await expect(Promise.resolve(getPlatformAPI().host)).resolves.toBe(getPlatformAPI().host);

        vi.unstubAllGlobals();
    });
});
