import {
    normalizeLocale,
    normalizeTheme,
    sanitizeSettings,
} from '@contracts/settings';
import type { ISettingsData } from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    BROWSER_LOCALE_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS,
    BROWSER_THEME_COOKIE_KEY,
    parseBrowserSettingsPayload,
    serializeBrowserSettingsPayload,
} from '@app/utils/browserSettingsPersistence';
import { safeDecodeURIComponent } from '@app/utils/browserSafe';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import { usePlatformHydratedState } from '@app/composables/usePlatformHydratedState';
import {
    createSettingsPersistenceQueue,
    type ISettingsPersistenceQueue,
} from '@app/modules/settings/settingsPersistenceQueue';

const PERSISTENT_SETTINGS_COOKIE_OPTIONS = {
    watch: false,
    maxAge: BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax' as const,
    path: '/',
};
let settingsPersistenceQueue: ISettingsPersistenceQueue | null = null;

export const useSettings = () => {
    const settingsCookie = useCookie<string | Partial<ISettingsData> | null>(BROWSER_SETTINGS_COOKIE_KEY, {
        ...PERSISTENT_SETTINGS_COOKIE_OPTIONS,
        default: () => null,
        decode: value => typeof value === 'string'
            ? safeDecodeURIComponent(value)
            : null,
    });
    const localeCookie = useCookie(
        BROWSER_LOCALE_COOKIE_KEY,
        PERSISTENT_SETTINGS_COOKIE_OPTIONS,
    );
    const themeCookie = useCookie(
        BROWSER_THEME_COOKIE_KEY,
        PERSISTENT_SETTINGS_COOKIE_OPTIONS,
    );
    const hasSettingsCookie = settingsCookie.value !== null;
    const hasSettingsCookieSnapshot = useState(
        'settings:has-cookie-snapshot',
        () => hasSettingsCookie
            || localeCookie.value != null
            || themeCookie.value != null,
    );
    const fallbackSettings: Partial<ISettingsData> = {};
    if (localeCookie.value != null) {
        fallbackSettings.locale = normalizeLocale(localeCookie.value);
    }
    if (themeCookie.value != null) {
        fallbackSettings.theme = normalizeTheme(themeCookie.value);
    }
    const initialSettings = parseBrowserSettingsPayload(settingsCookie.value, fallbackSettings);
    const lastSavedSettings = useState<ISettingsData | null>(
        'settings:last-saved',
        () => hasSettingsCookieSnapshot.value
            ? sanitizeSettings(initialSettings)
            : null,
    );

    function rememberSavedSettings(nextSettings: ISettingsData) {
        lastSavedSettings.value = sanitizeSettings(nextSettings);
    }

    function syncSettingsCookies(nextSettings: ISettingsData) {
        settingsCookie.value = serializeBrowserSettingsPayload(nextSettings);
        localeCookie.value = nextSettings.locale;
        themeCookie.value = nextSettings.theme;
        hasSettingsCookieSnapshot.value = true;
    }

    const {
        state: settings,
        isResolved: isLoaded,
        load: loadSettingsState,
    } = usePlatformHydratedState<ISettingsData>({
        key: 'settings',
        initialValue: () => initialSettings,
        initialResolved: hasSettingsCookieSnapshot.value,
        async loadValue() {
            const loadedSettings = await getSettingsCapability().get();
            return sanitizeSettings(loadedSettings);
        },
        onLoaded(nextSettings) {
            const sanitizedSettings = sanitizeSettings(nextSettings);
            syncSettingsCookies(sanitizedSettings);
            rememberSavedSettings(sanitizedSettings);
        },
        onError(loadError) {
            BrowserLogger.error('settings', 'Failed to load settings', loadError);
        },
    });

    async function load() {
        const loadedSettings = await loadSettingsState();
        if (loadedSettings) {
            const sanitizedSettings = sanitizeSettings(loadedSettings);
            syncSettingsCookies(sanitizedSettings);
            rememberSavedSettings(sanitizedSettings);
        }
    }

    function getSettingsPersistenceQueue() {
        if (settingsPersistenceQueue) {
            return settingsPersistenceQueue;
        }

        settingsPersistenceQueue = createSettingsPersistenceQueue({
            getSettingsSnapshot: () => toRaw(settings.value),
            getLastSavedSettings: () => lastSavedSettings.value,
            savePatch: patch => getSettingsCapability().save(patch),
            onSaved(nextSettings) {
                rememberSavedSettings(nextSettings);
                syncSettingsCookies(nextSettings);
            },
            onSaveError(error) {
                BrowserLogger.error('settings', 'Failed to save settings', error);
            },
        });
        return settingsPersistenceQueue;
    }

    async function save() {
        return getSettingsPersistenceQueue().save();
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

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        settingsPersistenceQueue?.clearRetryTimer();
        settingsPersistenceQueue = null;
    });
}
