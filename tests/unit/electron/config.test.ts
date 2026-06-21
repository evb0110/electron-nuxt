import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as ElectronConfigModule from '@electron/config';

const mocks = vi.hoisted(() => ({app: {isPackaged: false}}));

vi.mock('electron', () => ({app: mocks.app}));

const originalResourcesPath = process.resourcesPath;

function setResourcesPath(value: string | undefined) {
    Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value,
    });
}

describe('electron config runtime mode', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
        mocks.app.isPackaged = false;
        setResourcesPath('/Applications/EVB Viewer.app/Contents/Resources');
    });

    afterAll(() => {
        setResourcesPath(originalResourcesPath);
    });

    it('uses Electron app.isPackaged for development mode detection', async () => {
        mocks.app.isPackaged = false;

        const configModule: typeof ElectronConfigModule = await import('@electron/config');
        const {
            config,
            resolveIsPackaged,
        } = configModule;

        expect(resolveIsPackaged()).toBe(false);
        expect(config.isDev).toBe(true);
        expect(config.renderer.url).toBe(config.server.url);
        expect(config.renderer.trustedOrigin).toBe(new URL(config.server.url).origin);
        expect(config.renderer.trustedUrl).toBe(config.server.url);
        expect(config.renderer.staticRoot).toContain('nuxt-output/public');
    });

    it('uses Electron app.isPackaged for packaged mode detection without inspecting module paths', async () => {
        mocks.app.isPackaged = true;

        const configModule: typeof ElectronConfigModule = await import('@electron/config');
        const {
            config,
            resolveIsPackaged,
        } = configModule;

        expect(resolveIsPackaged()).toBe(true);
        expect(config.isDev).toBe(false);
        expect(config.renderer.url).toBe('evb-viewer://app/electron');
        expect(config.renderer.trustedOrigin).toBe('evb-viewer://app');
        expect(config.renderer.trustedUrl).toBe('evb-viewer://app/electron');
        expect(config.renderer.staticRoot).toBe('/Applications/EVB Viewer.app/Contents/Resources/app.asar/nuxt-output/public');
    });

    it('falls back to loopback when a remote dev server host is configured without unsafe opt-in', async () => {
        vi.stubEnv('EVB_SERVER_HOST', 'example.com');

        const { config }: typeof ElectronConfigModule = await import('@electron/config');

        expect(config.server.host).toBe('127.0.0.1');
        expect(config.renderer.trustedOrigin).toBe('http://127.0.0.1:3235');
    });

    it('allows remote dev server hosts only behind an explicit unsafe opt-in', async () => {
        vi.stubEnv('EVB_SERVER_HOST', 'example.com');
        vi.stubEnv('EVB_ALLOW_UNSAFE_REMOTE_DEV_SERVER', '1');

        const { config }: typeof ElectronConfigModule = await import('@electron/config');

        expect(config.server.host).toBe('example.com');
        expect(config.renderer.trustedOrigin).toBe('http://example.com:3235');
    });
});
