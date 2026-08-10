import type {
    IDebugLogEntry,
    IRendererLogEntry,
} from '@contracts/electronApiCommon';
import type {
    ISettingsCapability,
    SETTINGS_PLATFORM_FEATURE,
} from '@contracts/settingsPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import {
    DEFAULT_SETTINGS,
    normalizeLocale,
    normalizeTheme,
    sanitizeSettings,
} from '@contracts/settings';
import type { ISettingsData } from '@contracts/shared';
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
import { safeDecodeURIComponent } from '@app/utils/browserSafe';
import { SETTINGS_STORAGE_KEY } from '@app/platform/browser-api/browserApiStorageKeys';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';

let settingsState: ISettingsData = { ...DEFAULT_SETTINGS };
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

    const fallbackSettings: Partial<ISettingsData> = {};
    if (localeCookie) {
        fallbackSettings.locale = normalizeLocale(safeDecodeURIComponent(localeCookie));
    }
    if (themeCookie) {
        fallbackSettings.theme = normalizeTheme(safeDecodeURIComponent(themeCookie));
    }

    return parseBrowserSettingsPayload(
        rawSettingsCookie ? safeDecodeURIComponent(rawSettingsCookie) : null,
        fallbackSettings,
    );
}

function readBrowserSettingsFromStorage() {
    const rawSettings = safeGetLocalStorageItem(SETTINGS_STORAGE_KEY);
    if (!rawSettings) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(rawSettings);
        return sanitizeSettings(parsed);
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
            settingsState = readBrowserSettingsFromCookie()
                ?? readBrowserSettingsFromStorage()
                ?? { ...DEFAULT_SETTINGS };
            browserSettingsLoaded = true;
        }

        return Promise.resolve(sanitizeSettings(settingsState));
    },
    save(settings) {
        const currentSettings = browserSettingsLoaded
            ? settingsState
            : readBrowserSettingsFromCookie()
                ?? readBrowserSettingsFromStorage()
                ?? { ...DEFAULT_SETTINGS };
        const nextSettings = sanitizeSettings({
            ...currentSettings,
            ...settings,
        });
        settingsState = nextSettings;
        browserSettingsLoaded = true;
        writeBrowserSettingsToStorage(nextSettings);
        writeBrowserSettingsToCookie(nextSettings);
        return Promise.resolve(undefined);
    },
    getDebugLogs(): Promise<IDebugLogEntry[]> {
        return Promise.resolve([]);
    },
    onDebugLog: noopUnsubscribe,
    rendererLog(_entry: IRendererLogEntry) {},
};

browserSettingsCapability satisfies TFeatureBrowserBindings<typeof SETTINGS_PLATFORM_FEATURE>;
