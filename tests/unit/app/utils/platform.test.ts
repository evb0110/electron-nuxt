import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import {
    isElectronUserAgent,
    shouldPreferDesktopPlatform,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';

describe('platform runtime detection', () => {
    it('prefers the desktop platform only when runtime state or the bridge requires it', () => {
        expect(shouldPreferDesktopPlatform('/', true, false)).toBe(true);
        expect(shouldPreferDesktopPlatform('/electron', false, false)).toBe(true);
        expect(shouldPreferDesktopPlatform('/', false, true)).toBe(true);
        expect(shouldPreferDesktopPlatform('/', false, false)).toBe(false);
    });

    it('short-circuits bridge waiting when desktop is not required', async () => {
        await expect(waitForDesktopPlatformBridge({shouldWait: false})).resolves.toBe(false);
    });

    it('detects Electron user agents without treating browsers as Electron', () => {
        expect(isElectronUserAgent('Mozilla/5.0 AppleWebKit/537.36 Electron/39.2.3 Safari/537.36')).toBe(true);
        expect(isElectronUserAgent('Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36')).toBe(false);
        expect(isElectronUserAgent('')).toBe(false);
    });

    it('does not load the browser platform fallback while an electron api is present', async () => {
        vi.resetModules();
        let browserPlatformImportCount = 0;
        vi.doMock('@app/platform/browserPlatformApi', () => {
            browserPlatformImportCount += 1;
            return { browserPlatformApi: { shell: { openExternal: vi.fn().mockResolvedValue(undefined) } } };
        });

        const electronAPI = createElectronPlatformApiFixture({ shell: { openExternal: vi.fn().mockResolvedValue(undefined) } });
        vi.stubGlobal('window', { electronAPI });

        const { getPlatformAPI } = await import('@app/utils/platform');

        expect(getPlatformAPI()).toBe(electronAPI);
        expect(browserPlatformImportCount).toBe(0);

        vi.unstubAllGlobals();
        vi.doUnmock('@app/platform/browserPlatformApi');
    });

    it('loads the browser platform fallback lazily when a browser capability is used', async () => {
        vi.resetModules();
        let browserPlatformImportCount = 0;
        const openExternal = vi.fn().mockResolvedValue(undefined);
        vi.doMock('@app/platform/browserPlatformApi', () => {
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
        vi.doUnmock('@app/platform/browserPlatformApi');
    });

    it('does not treat lazy browser capabilities as thenables', async () => {
        vi.resetModules();
        vi.stubGlobal('window', {});

        const { getPlatformAPI } = await import('@app/utils/platform');

        await expect(Promise.resolve(getPlatformAPI().host)).resolves.toBe(getPlatformAPI().host);

        vi.unstubAllGlobals();
    });
});
