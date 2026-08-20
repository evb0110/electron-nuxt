import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { MemoryStorage } from '@tests/unit/app/platform/browserPlatformTestDoubles';

describe('browserSettingsCapability', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('preserves cookie-backed locale and theme when saving before get', async () => {
        const cookies = new Map<string, string>();
        const cookieWrites: string[] = [];
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', { localStorage });
        vi.stubGlobal('location', {protocol: 'https:'});
        vi.stubGlobal('document', {
            get cookie() {
                return Array.from(cookies.entries())
                    .map(([
                        key,
                        value,
                    ]) => `${key}=${value}`)
                    .join('; ');
            },
            set cookie(value: string) {
                cookieWrites.push(value);
                const [pair] = value.split(';');
                const separatorIndex = pair?.indexOf('=') ?? -1;
                if (!pair || separatorIndex < 0) {
                    return;
                }
                const key = pair.slice(0, separatorIndex);
                if (value.includes('Max-Age=0')) {
                    cookies.delete(key);
                } else {
                    cookies.set(key, pair.slice(separatorIndex + 1));
                }
            },
        });

        const {
            BROWSER_LOCALE_COOKIE_KEY,
            BROWSER_SETTINGS_COOKIE_KEY,
            BROWSER_THEME_COOKIE_KEY,
        } = await import('@app/utils/browserSettingsPersistence');
        cookies.set(BROWSER_LOCALE_COOKIE_KEY, encodeURIComponent('ru'));
        cookies.set(BROWSER_THEME_COOKIE_KEY, encodeURIComponent('dark'));

        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');
        await browserSettingsCapability.save({
            authorName: 'Browser User',
            assistantPanelEnabled: false,
        });
        const settings = await browserSettingsCapability.get();

        expect(settings.authorName).toBe('Browser User');
        expect(settings.assistantPanelEnabled).toBe(false);
        expect(settings.locale).toBe('ru');
        expect(settings.theme).toBe('dark');
        expect(cookies.has(BROWSER_SETTINGS_COOKIE_KEY)).toBe(false);
        expect(Array.from(cookies.keys()).sort()).toEqual([
            BROWSER_LOCALE_COOKIE_KEY,
            BROWSER_THEME_COOKIE_KEY,
        ].sort());
        expect(localStorage.getItem('evb-viewer:browser:settings')).not.toBeNull();
        expect(cookieWrites.filter(value => !value.includes('Max-Age=0'))).toEqual([
            expect.stringContaining('; SameSite=Lax; Secure'),
            expect.stringContaining('; SameSite=Lax; Secure'),
        ]);
    });

    it('migrates and removes the legacy full-settings request cookie', async () => {
        const cookies = new Map<string, string>();
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', { localStorage });
        vi.stubGlobal('document', {
            get cookie() {
                return Array.from(cookies.entries()).map(([
                    key,
                    value,
                ]) => `${key}=${value}`).join('; ');
            },
            set cookie(value: string) {
                const [pair] = value.split(';');
                const separatorIndex = pair?.indexOf('=') ?? -1;
                if (!pair || separatorIndex < 0) {
                    return;
                }
                const key = pair.slice(0, separatorIndex);
                if (value.includes('Max-Age=0')) {
                    cookies.delete(key);
                } else {
                    cookies.set(key, pair.slice(separatorIndex + 1));
                }
            },
        });
        const {
            BROWSER_SETTINGS_COOKIE_KEY,
            serializeBrowserSettingsPayload,
        } = await import('@app/utils/browserSettingsPersistence');
        const { DEFAULT_SETTINGS } = await import('@contracts/settings');
        localStorage.setItem('evb-viewer:browser:settings', JSON.stringify({
            ...DEFAULT_SETTINGS,
            authorName: 'Divergent Storage User',
            performanceMode: 'high',
        }));
        cookies.set(BROWSER_SETTINGS_COOKIE_KEY, encodeURIComponent(serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            authorName: 'Migrated User',
            performanceMode: 'low',
        })));

        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');
        const settings = await browserSettingsCapability.get();

        expect(settings).toMatchObject({
            authorName: 'Migrated User',
            performanceMode: 'low',
        });
        expect(cookies.has(BROWSER_SETTINGS_COOKIE_KEY)).toBe(false);
        expect(JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? 'null'))
            .toMatchObject({
                authorName: 'Migrated User',
                performanceMode: 'low',
            });
    });

    it('ignores malformed browser settings cookies', async () => {
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', { localStorage });
        vi.stubGlobal('document', {
            get cookie() {
                return 'evb_viewer_settings=%E0%A4%A; i18n_redirected=%E0%A4%A; evb_viewer_theme=%E0%A4%A';
            },
            set cookie(value: string) {
                void value;
            },
        });

        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');
        const settings = await browserSettingsCapability.get();

        expect(settings.locale).toBe('en');
        expect(settings.theme).toBe('light');
    });
});
