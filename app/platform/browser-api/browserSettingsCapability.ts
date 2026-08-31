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
    readLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import {
    BROWSER_LOCALE_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS,
    BROWSER_THEME_COOKIE_KEY,
    expireLegacyBrowserSettingsCookie,
    assertSupportedBrowserSettingsPayload,
    isValidBrowserSettingsStoragePayload,
    isValidLegacyBrowserSettingsPayload,
    parseBrowserSettingsPayload,
} from '@app/utils/browserSettingsPersistence';
import { safeDecodeURIComponent } from '@app/utils/browserSafe';
import { SETTINGS_STORAGE_KEY } from '@app/platform/browser-api/browserApiStorageKeys';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';

let settingsState: ISettingsData = { ...DEFAULT_SETTINGS };
let browserSettingsLoaded = false;

function writeBrowserSettingsToStorage(nextSettings: ISettingsData) {
    if (!safeSetLocalStorageItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings))) {
        throw new Error('Failed to persist browser settings to localStorage');
    }
}

function readBrowserSettingsCookies() {
    if (typeof document === 'undefined') {
        return null;
    }

    const getCookieValue = (key: string) => document.cookie.match(
        new RegExp(`(?:^|; )${key}=([^;]*)`, 'u'),
    )?.[1] ?? null;
    const rawSettingsCookie = getCookieValue(BROWSER_SETTINGS_COOKIE_KEY);
    const localeCookie = getCookieValue(BROWSER_LOCALE_COOKIE_KEY);
    const themeCookie = getCookieValue(BROWSER_THEME_COOKIE_KEY);
    if (rawSettingsCookie === null && localeCookie === null && themeCookie === null) {
        return null;
    }

    const fallbackSettings: Partial<ISettingsData> = {};
    if (localeCookie) {
        fallbackSettings.locale = normalizeLocale(safeDecodeURIComponent(localeCookie));
    }
    if (themeCookie) {
        fallbackSettings.theme = normalizeTheme(safeDecodeURIComponent(themeCookie));
    }

    return {
        fallbackSettings,
        rawSettings: rawSettingsCookie === null
            ? null
            : safeDecodeURIComponent(rawSettingsCookie),
    };
}

function readBrowserSettingsFromStorage() {
    const result = readLocalStorageItem(SETTINGS_STORAGE_KEY);
    if (result.status === 'unavailable') {
        throw result.error;
    }
    if (result.status === 'absent') {
        return null;
    }

    const rawSettings = result.value;
    assertSupportedBrowserSettingsPayload(rawSettings);
    if (!isValidBrowserSettingsStoragePayload(rawSettings)) {
        return null;
    }
    return sanitizeSettings(JSON.parse(rawSettings));
}

function readLatestBrowserSettingsForSave() {
    const persistedSettings = readBrowserSettingsFromStorage();
    if (persistedSettings) {
        return persistedSettings;
    }

    if (browserSettingsLoaded) {
        return settingsState;
    }

    return readAndMigrateBrowserSettings()
        ?? { ...DEFAULT_SETTINGS };
}

function writeBrowserSettingsBootstrapCookies(nextSettings: ISettingsData) {
    if (typeof document === 'undefined') {
        return;
    }

    expireLegacyBrowserSettingsCookie();
    const secureAttribute = typeof location !== 'undefined' && location.protocol === 'https:'
        ? '; Secure'
        : '';
    document.cookie = `${BROWSER_LOCALE_COOKIE_KEY}=${encodeURIComponent(nextSettings.locale)}; Path=/; Max-Age=${BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secureAttribute}`;
    document.cookie = `${BROWSER_THEME_COOKIE_KEY}=${encodeURIComponent(nextSettings.theme)}; Path=/; Max-Age=${BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secureAttribute}`;
}

function readAndMigrateBrowserSettings() {
    const cookieSnapshot = readBrowserSettingsCookies();
    if (cookieSnapshot && cookieSnapshot.rawSettings !== null) {
        assertSupportedBrowserSettingsPayload(cookieSnapshot.rawSettings);
        const isValidLegacyCookie = isValidLegacyBrowserSettingsPayload(cookieSnapshot.rawSettings);
        if (isValidLegacyCookie) {
            const legacySettings = parseBrowserSettingsPayload(
                cookieSnapshot.rawSettings,
                cookieSnapshot.fallbackSettings,
            );
            writeBrowserSettingsToStorage(legacySettings);
            expireLegacyBrowserSettingsCookie();
            return legacySettings;
        }
        expireLegacyBrowserSettingsCookie();
    }

    const persistedSettings = readBrowserSettingsFromStorage();
    if (persistedSettings) {
        return persistedSettings;
    }

    if (cookieSnapshot) {
        const bootstrapSettings = parseBrowserSettingsPayload(
            null,
            cookieSnapshot.fallbackSettings,
        );
        writeBrowserSettingsToStorage(bootstrapSettings);
        return bootstrapSettings;
    }
    return null;
}

export const browserSettingsCapability: ISettingsCapability = {
    get() {
        return Promise.resolve().then(() => {
            if (!browserSettingsLoaded) {
                settingsState = readAndMigrateBrowserSettings()
                    ?? { ...DEFAULT_SETTINGS };
                writeBrowserSettingsBootstrapCookies(settingsState);
                browserSettingsLoaded = true;
            }
            return sanitizeSettings(settingsState);
        });
    },
    save(settings) {
        return Promise.resolve().then(() => {
            const currentSettings = readLatestBrowserSettingsForSave();
            const nextSettings = sanitizeSettings({
                ...currentSettings,
                ...settings,
            });
            writeBrowserSettingsToStorage(nextSettings);
            writeBrowserSettingsBootstrapCookies(nextSettings);
            settingsState = nextSettings;
            browserSettingsLoaded = true;
        });
    },
    getDebugLogs(): Promise<IDebugLogEntry[]> {
        return Promise.resolve([]);
    },
    onDebugLog: noopUnsubscribe,
    rendererLog(_entry: IRendererLogEntry) {},
};

browserSettingsCapability satisfies TFeatureBrowserBindings<typeof SETTINGS_PLATFORM_FEATURE>;
