import { sanitizeSettings } from '@contracts/settings';
import type {
    ISettingsData,
    TAppLocale,
    TAppTheme,
} from '@contracts/shared';
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

export const useSettings = () => {
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
    const fallbackSettings: Partial<ISettingsData> = {};
    if (localeCookie.value !== null && localeCookie.value !== undefined) {
        fallbackSettings.locale = localeCookie.value as TAppLocale;
    }
    if (themeCookie.value !== null && themeCookie.value !== undefined) {
        fallbackSettings.theme = themeCookie.value as TAppTheme;
    }
    const initialSettings = parseBrowserSettingsPayload(settingsCookie.value, fallbackSettings);

    function syncSettingsCookies(nextSettings: ISettingsData) {
        const serializedSettings = serializeBrowserSettingsPayload(nextSettings);
        settingsCookie.value = serializedSettings;
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
            const loadedSettings = await getPlatformAPI().settings.get();
            return sanitizeSettings(loadedSettings);
        },
        onLoaded(nextSettings) {
            syncSettingsCookies(nextSettings);
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

    async function runSaveQueue() {
        while (true) {
            saveDirty = false;
            const payload = sanitizeSettings(toRaw(settings.value));
            try {
                await getPlatformAPI().settings.save(payload);
                syncSettingsCookies(payload);
            } catch (e) {
                BrowserLogger.error('settings', 'Failed to save settings', e);
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

    return {
        settings,
        isLoaded,
        hasCookieSnapshot: hasSettingsCookieSnapshot,
        load,
        save,
        updateSetting,
    };
};
