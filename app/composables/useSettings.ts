import { sanitizeSettings } from '@contracts/settings';
import type {
    ISettingsData,
    TAppLocale,
    TAppTheme,
} from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browser-logger';
import {
    BROWSER_LOCALE_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_KEY,
    BROWSER_THEME_COOKIE_KEY,
    parseBrowserSettingsPayload,
    serializeBrowserSettingsPayload,
} from '@app/utils/browser-settings-persistence';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/platform';

// Deduplication: track in-flight load promise
let loadPromise: Promise<void> | null = null;

export const useSettings = () => {
    const isBrowserRuntime = !hasElectronAPI();
    const settingsCookie = useCookie<string | Partial<ISettingsData> | null>(BROWSER_SETTINGS_COOKIE_KEY, {
        default: () => null,
        watch: false,
        decode: value => decodeURIComponent(value),
    });
    const localeCookie = useCookie<string | null | undefined>(BROWSER_LOCALE_COOKIE_KEY, { watch: false });
    const themeCookie = useCookie<string | null | undefined>(BROWSER_THEME_COOKIE_KEY, { watch: false });
    const hasSettingsCookie = settingsCookie.value !== null;
    const hasSettingsCookieSnapshot = useState(
        'settings:has-cookie-snapshot',
        () => hasSettingsCookie
            || localeCookie.value != null
            || themeCookie.value != null,
    );
    const initialSettings = parseBrowserSettingsPayload(settingsCookie.value, {
        locale: localeCookie.value as TAppLocale | undefined,
        theme: themeCookie.value as TAppTheme | undefined,
    });
    const settings = useState<ISettingsData>(
        'settings:data',
        () => initialSettings,
    );
    const isLoaded = useState(
        'settings:is-loaded',
        () => (isBrowserRuntime ? hasSettingsCookieSnapshot.value : hasSettingsCookie),
    );

    function syncSettingsCookies(nextSettings: ISettingsData) {
        const serializedSettings = serializeBrowserSettingsPayload(nextSettings);
        settingsCookie.value = serializedSettings;
        localeCookie.value = nextSettings.locale;
        themeCookie.value = nextSettings.theme;
        hasSettingsCookieSnapshot.value = true;
    }

    async function load() {
        // Deduplicate: if already loading, return existing promise
        if (loadPromise) {
            return loadPromise;
        }

        loadPromise = (async () => {
            try {
                const loadedSettings = await getElectronAPI().settings.get();
                settings.value = sanitizeSettings(loadedSettings);
                syncSettingsCookies(settings.value);
                isLoaded.value = true;
            } catch (e) {
                BrowserLogger.error('settings', 'Failed to load settings', e);
            } finally {
                loadPromise = null;
            }
        })();

        return loadPromise;
    }

    async function save() {
        try {
            const payload = sanitizeSettings(toRaw(settings.value));
            await getElectronAPI().settings.save(payload);
            syncSettingsCookies(payload);
        } catch (e) {
            BrowserLogger.error('settings', 'Failed to save settings', e);
        }
    }

    function updateSetting<K extends keyof ISettingsData>(key: K, value: ISettingsData[K]) {
        settings.value = {
            ...settings.value,
            [key]: value, 
        };
        void save();
    }

    return {
        settings,
        isLoaded,
        hasCookieSnapshot: hasSettingsCookieSnapshot,
        load,
        save,
        updateSetting,
    };
};
