import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

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
        mocks.app.isPackaged = false;
        setResourcesPath('/Applications/EVB Viewer.app/Contents/Resources');
    });

    afterAll(() => {
        setResourcesPath(originalResourcesPath);
    });

    it('uses Electron app.isPackaged for development mode detection', async () => {
        mocks.app.isPackaged = false;

        const {
            config,
            resolveIsPackaged,
        } = await import('@electron/config');

        expect(resolveIsPackaged()).toBe(false);
        expect(config.isDev).toBe(true);
        expect(config.renderer.url).toBe(config.server.url);
        expect(config.renderer.trustedOrigin).toBe(new URL(config.server.url).origin);
        expect(config.renderer.staticRoot).toContain('nuxt-output/public');
    });

    it('uses Electron app.isPackaged for packaged mode detection without inspecting module paths', async () => {
        mocks.app.isPackaged = true;

        const {
            config,
            resolveIsPackaged,
        } = await import('@electron/config');

        expect(resolveIsPackaged()).toBe(true);
        expect(config.isDev).toBe(false);
        expect(config.renderer.url).toBe('evb-viewer://app/electron');
        expect(config.renderer.trustedOrigin).toBe('evb-viewer://app');
        expect(config.renderer.staticRoot).toBe('/Applications/EVB Viewer.app/Contents/Resources/app.asar/nuxt-output/public');
    });
});
