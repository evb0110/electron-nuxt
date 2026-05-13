import type {
    IDebugLogEntry,
    IRendererLogEntry,
    ISettingsCapability,
} from '@contracts/platformApi';
import {
    DEFAULT_SETTINGS,
    sanitizeSettings,
} from '@contracts/settings';
import type {
    ISettingsData,
    TAppLocale,
    TAppTheme,
} from '@contracts/shared';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import {
    BROWSER_LOCALE_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS,
    BROWSER_THEME_COOKIE_KEY,
    parseBrowserSettingsPayload,
    serializeBrowserSettingsPayload,
} from '@app/utils/browserSettingsPersistence';
import {
    SETTINGS_STORAGE_KEY,
    noopUnsubscribe,
} from '@app/platform/browser-api/common';

const settingsState = ref<ISettingsData>({ ...DEFAULT_SETTINGS });
let browserSettingsLoaded = false;

function writeBrowserSettingsToStorage(nextSettings: ISettingsData) {
    safeSetLocalStorageItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings));
}

function readBrowserSettingsFromCookie() {
    if (typeof document === 'undefined') {
        return null;
    }

    const getCookieValue = (key: string) => document.cookie.match(
        new RegExp(`(?:^|; )${key}=([^;]*)`, 'u'),
    )?.[1] ?? null;
    const rawSettingsCookie = getCookieValue(BROWSER_SETTINGS_COOKIE_KEY);
    const localeCookie = getCookieValue(BROWSER_LOCALE_COOKIE_KEY);
    const themeCookie = getCookieValue(BROWSER_THEME_COOKIE_KEY);
    if (!rawSettingsCookie && !localeCookie && !themeCookie) {
        return null;
    }

    return parseBrowserSettingsPayload(
        rawSettingsCookie ? decodeURIComponent(rawSettingsCookie) : null,
        {
            locale: localeCookie ? decodeURIComponent(localeCookie) as TAppLocale : undefined,
            theme: themeCookie ? decodeURIComponent(themeCookie) as TAppTheme : undefined,
        },
    );
}

function readBrowserSettingsFromStorage() {
    const rawSettings = safeGetLocalStorageItem(SETTINGS_STORAGE_KEY);
    if (!rawSettings) {
        return null;
    }

    try {
        return sanitizeSettings(JSON.parse(rawSettings) as Partial<ISettingsData>);
    } catch {
        return null;
    }
}

function writeBrowserSettingsToCookie(nextSettings: ISettingsData) {
    if (typeof document === 'undefined') {
        return;
    }

    const encodedValue = encodeURIComponent(serializeBrowserSettingsPayload(nextSettings));
    document.cookie = `${BROWSER_SETTINGS_COOKIE_KEY}=${encodedValue}; Path=/; Max-Age=${BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
    document.cookie = `${BROWSER_LOCALE_COOKIE_KEY}=${encodeURIComponent(nextSettings.locale)}; Path=/; Max-Age=${BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
    document.cookie = `${BROWSER_THEME_COOKIE_KEY}=${encodeURIComponent(nextSettings.theme)}; Path=/; Max-Age=${BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

export const browserSettingsCapability: ISettingsCapability = {
    get() {
        if (!browserSettingsLoaded) {
            settingsState.value = readBrowserSettingsFromCookie()
                ?? readBrowserSettingsFromStorage()
                ?? { ...DEFAULT_SETTINGS };
            browserSettingsLoaded = true;
        }

        return Promise.resolve(sanitizeSettings(settingsState.value));
    },
    save(settings) {
        const nextSettings = sanitizeSettings(settings);
        settingsState.value = nextSettings;
        browserSettingsLoaded = true;
        writeBrowserSettingsToStorage(nextSettings);
        writeBrowserSettingsToCookie(nextSettings);
        return Promise.resolve();
    },
    getDebugLogs(): Promise<IDebugLogEntry[]> {
        return Promise.resolve([]);
    },
    onDebugLog: noopUnsubscribe,
    rendererLog(_entry: IRendererLogEntry) {},
    onMenuOpenSettings: noopUnsubscribe,
};
