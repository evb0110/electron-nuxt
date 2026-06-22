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
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', { localStorage });
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
                const [pair] = value.split(';');
                const separatorIndex = pair?.indexOf('=') ?? -1;
                if (!pair || separatorIndex < 0) {
                    return;
                }
                cookies.set(
                    pair.slice(0, separatorIndex),
                    pair.slice(separatorIndex + 1),
                );
            },
        });

        const {
            BROWSER_LOCALE_COOKIE_KEY,
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
