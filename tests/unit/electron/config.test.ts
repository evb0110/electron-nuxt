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

    it('falls back when an updater interval has a numeric prefix followed by other characters', async () => {
        vi.stubEnv('EVB_UPDATES_POLL_INTERVAL_MS', '60000ms');

        const { config }: typeof ElectronConfigModule = await import('@electron/config');

        expect(config.updates.pollIntervalMs).toBe(6 * 60 * 60 * 1000);
    });

    it('falls back when an updater interval exceeds the one-week product maximum', async () => {
        vi.stubEnv('EVB_UPDATES_POLL_INTERVAL_MS', '604800001');

        const { config }: typeof ElectronConfigModule = await import('@electron/config');

        expect(config.updates.pollIntervalMs).toBe(6 * 60 * 60 * 1000);
    });

    it('accepts the exact positive and one-week updater interval boundaries', async () => {
        vi.stubEnv('EVB_UPDATES_INITIAL_DELAY_MS', '1');
        vi.stubEnv('EVB_UPDATES_POLL_INTERVAL_MS', '604800000');

        const { config }: typeof ElectronConfigModule = await import('@electron/config');

        expect({
            initialDelayMs: config.updates.initialDelayMs,
            pollIntervalMs: config.updates.pollIntervalMs,
        }).toEqual({
            initialDelayMs: 1,
            pollIntervalMs: 604_800_000,
        });
    });

    it('preserves updater interval defaults when overrides are absent', async () => {
        const { config }: typeof ElectronConfigModule = await import('@electron/config');

        expect({
            initialDelayMs: config.updates.initialDelayMs,
            pollIntervalMs: config.updates.pollIntervalMs,
        }).toEqual({
            initialDelayMs: 2 * 60 * 1000,
            pollIntervalMs: 6 * 60 * 60 * 1000,
        });
    });

    it.each([
        '0',
        '-1',
        '1.5',
        '1e3',
        'Infinity',
        'NaN',
        ' 60000',
        '60000 ',
        '+60000',
        '2147483647',
        '999999999999',
    ])('falls back for invalid updater interval %j', async (raw) => {
        vi.stubEnv('EVB_UPDATES_INITIAL_DELAY_MS', raw);
        vi.stubEnv('EVB_UPDATES_POLL_INTERVAL_MS', raw);

        const { config }: typeof ElectronConfigModule = await import('@electron/config');

        expect({
            initialDelayMs: config.updates.initialDelayMs,
            pollIntervalMs: config.updates.pollIntervalMs,
        }).toEqual({
            initialDelayMs: 2 * 60 * 1000,
            pollIntervalMs: 6 * 60 * 60 * 1000,
        });
    });

    it('falls back when a full decimal interval is too large to represent as a finite number', async () => {
        vi.stubEnv('EVB_UPDATES_POLL_INTERVAL_MS', '9'.repeat(400));

        const { config }: typeof ElectronConfigModule = await import('@electron/config');

        expect(config.updates.pollIntervalMs).toBe(6 * 60 * 60 * 1000);
    });

    it('keeps an overflowing deployed interval from creating a near-immediate timer', async () => {
        vi.useFakeTimers();
        vi.stubEnv('EVB_UPDATES_POLL_INTERVAL_MS', '999999999999');

        try {
            const { config }: typeof ElectronConfigModule = await import('@electron/config');
            const callback = vi.fn();
            const timer = setTimeout(callback, config.updates.pollIntervalMs);

            await vi.advanceTimersByTimeAsync(1);

            expect(callback).not.toHaveBeenCalled();
            clearTimeout(timer);
        } finally {
            vi.useRealTimers();
        }
    });
});
