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
    BROWSER_THEME_COOKIE_KEY,
    parseBrowserSettingsPayload,
    serializeBrowserSettingsPayload,
} from '@app/utils/browserSettingsPersistence';
import { getPlatformAPI } from '@app/utils/platform';
import { usePlatformHydratedState } from '@app/composables/usePlatformHydratedState';

const SETTINGS_SAVE_RETRY_INITIAL_DELAY_MS = 1_000;
const SETTINGS_SAVE_RETRY_MAX_DELAY_MS = 30_000;

export const useSettings = () => {
    const settingsCookie = useCookie<string | Partial<ISettingsData> | null>(BROWSER_SETTINGS_COOKIE_KEY, {
        default: () => null,
        watch: false,
        decode: value => typeof value === 'string'
            ? decodeURIComponent(value)
            : null,
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
    const fallbackSettings: Partial<ISettingsData> = {};
    if (localeCookie.value != null) {
        fallbackSettings.locale = normalizeLocale(localeCookie.value);
    }
    if (themeCookie.value != null) {
        fallbackSettings.theme = normalizeTheme(themeCookie.value);
    }
    const initialSettings = parseBrowserSettingsPayload(settingsCookie.value, fallbackSettings);

    function syncSettingsCookies(nextSettings: ISettingsData) {
        settingsCookie.value = serializeBrowserSettingsPayload(nextSettings);
        localeCookie.value = nextSettings.locale;
        themeCookie.value = nextSettings.theme;
        hasSettingsCookieSnapshot.value = true;
    }

    function buildSettingsPatch(
        previousSettings: ISettingsData | null,
        nextSettings: ISettingsData,
    ): Partial<ISettingsData> {
        if (!previousSettings) {
            return nextSettings;
        }

        const baseSettings = previousSettings;
        const patch: Partial<ISettingsData> = {};
        function assignChangedSetting<TKey extends keyof ISettingsData>(key: TKey) {
            if (nextSettings[key] !== baseSettings[key]) {
                patch[key] = nextSettings[key];
            }
        }

        for (const key of Object.keys(nextSettings) as Array<keyof ISettingsData>) {
            assignChangedSetting(key);
        }
        return patch;
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
            const loadedSettings = await getPlatformAPI().settings.get();
            return sanitizeSettings(loadedSettings);
        },
        onLoaded(nextSettings) {
            syncSettingsCookies(nextSettings);
            lastSavedSettings = nextSettings;
        },
        onError(loadError) {
            BrowserLogger.error('settings', 'Failed to load settings', loadError);
        },
    });

    async function load() {
        await loadSettingsState();
    }

    let saveInFlight: Promise<void> | null = null;
    let saveDirty = false;
    let saveRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let saveRetryDelayMs = SETTINGS_SAVE_RETRY_INITIAL_DELAY_MS;
    let lastSavedSettings: ISettingsData | null = hasSettingsCookieSnapshot.value
        ? initialSettings
        : null;

    function clearSaveRetryTimer() {
        if (!saveRetryTimer) {
            return;
        }
        clearTimeout(saveRetryTimer);
        saveRetryTimer = null;
    }

    function scheduleSaveRetry() {
        if (saveRetryTimer) {
            return;
        }
        saveRetryTimer = setTimeout(() => {
            saveRetryTimer = null;
            void save();
        }, saveRetryDelayMs);
        saveRetryDelayMs = Math.min(saveRetryDelayMs * 2, SETTINGS_SAVE_RETRY_MAX_DELAY_MS);
    }

    async function runSaveQueue() {
        while (true) {
            saveDirty = false;
            const payload = sanitizeSettings(toRaw(settings.value));
            const patch = buildSettingsPatch(lastSavedSettings, payload);
            try {
                if (Object.keys(patch).length > 0) {
                    await getPlatformAPI().settings.save(patch);
                }
                lastSavedSettings = payload;
                syncSettingsCookies(payload);
                saveRetryDelayMs = SETTINGS_SAVE_RETRY_INITIAL_DELAY_MS;
            } catch (e) {
                BrowserLogger.error('settings', 'Failed to save settings', e);
                saveDirty = true;
                scheduleSaveRetry();
                return;
            }

            if (!saveDirty) {
                return;
            }
        }
    }

    async function save() {
        if (saveInFlight) {
            saveDirty = true;
            return saveInFlight;
        }

        clearSaveRetryTimer();
        saveInFlight = runSaveQueue().finally(() => {
            saveInFlight = null;
        });
        return saveInFlight;
    }

    function updateSetting<K extends keyof ISettingsData>(key: K, value: ISettingsData[K]) {
        settings.value = {
            ...settings.value,
            [key]: value, 
        };
        void save();
    }

    if (getCurrentScope()) {
        onScopeDispose(() => {
            clearSaveRetryTimer();
        });
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
