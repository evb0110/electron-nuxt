import {
    normalizeLocale,
    normalizeTheme,
    sanitizeSettings,
} from '@contracts/settings';
import type { ISettingsData } from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import {
    BROWSER_LOCALE_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS,
    BROWSER_THEME_COOKIE_KEY,
    parseBrowserSettingsPayload,
} from '@app/utils/browserSettingsPersistence';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import { usePlatformHydratedState } from '@app/composables/usePlatformHydratedState';
import {
    createSettingsPersistenceQueue,
    type ISettingsPersistenceQueue,
    type TSettingsPersistenceStatus,
} from '@app/modules/settings/public';

const PERSISTENT_SETTINGS_COOKIE_OPTIONS = {
    watch: false,
    maxAge: BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax' as const,
    path: '/',
    secure: import.meta.client && window.location?.protocol === 'https:',
};
const SETTINGS_SAVE_DEBOUNCE_MS = 400;
let settingsPersistenceQueue: ISettingsPersistenceQueue | null = null;
let settingsSaveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let flushDebouncedSettingsSave: (() => void) | null = null;
let settingsSaveFlushListener: (() => void) | null = null;

function cancelDebouncedSettingsSave() {
    if (settingsSaveDebounceTimer !== null) {
        clearTimeout(settingsSaveDebounceTimer);
        settingsSaveDebounceTimer = null;
    }
    flushDebouncedSettingsSave = null;
}

export const useSettings = () => {
    const localeCookie = useCookie(
        BROWSER_LOCALE_COOKIE_KEY,
        PERSISTENT_SETTINGS_COOKIE_OPTIONS,
    );
    const themeCookie = useCookie(
        BROWSER_THEME_COOKIE_KEY,
        PERSISTENT_SETTINGS_COOKIE_OPTIONS,
    );
    const hasSettingsCookieSnapshot = useState(
        'settings:has-cookie-snapshot',
        () => localeCookie.value != null
            || themeCookie.value != null,
    );
    const fallbackSettings: Partial<ISettingsData> = {};
    if (localeCookie.value != null) {
        fallbackSettings.locale = normalizeLocale(localeCookie.value);
    }
    if (themeCookie.value != null) {
        fallbackSettings.theme = normalizeTheme(themeCookie.value);
    }
    const initialSettings = parseBrowserSettingsPayload(null, fallbackSettings);
    const lastSavedSettings = useState<ISettingsData | null>(
        'settings:last-saved',
        () => null,
    );
    const settingsSaveStatus = useState<TSettingsPersistenceStatus>('settings:save-status', () => 'idle');
    const settingsSaveError = useState<string | null>('settings:save-error', () => null);
    const isSettingsSavePendingRetry = computed(() => settingsSaveStatus.value === 'retry-pending');

    function rememberSavedSettings(nextSettings: ISettingsData) {
        lastSavedSettings.value = sanitizeSettings(nextSettings);
    }

    function refreshSettingsBootstrapCookieSnapshot() {
        hasSettingsCookieSnapshot.value = localeCookie.value != null
            || themeCookie.value != null;
    }

    const {
        state: settings,
        isResolved: isLoaded,
        load: loadSettingsState,
    } = usePlatformHydratedState<ISettingsData>({
        key: 'settings',
        initialValue: () => initialSettings,
        initialResolved: false,
        async loadValue() {
            const loadedSettings = await getSettingsCapability().get();
            return sanitizeSettings(loadedSettings);
        },
        onLoaded(nextSettings) {
            refreshSettingsBootstrapCookieSnapshot();
            rememberSavedSettings(nextSettings);
        },
        onError(loadError) {
            BrowserLogger.error('settings', 'Failed to load settings', loadError);
        },
    });

    async function load() {
        await loadSettingsState();
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
                refreshSettingsBootstrapCookieSnapshot();
            },
            onSaveError(error) {
                BrowserLogger.error('settings', 'Failed to save settings', error);
            },
            onStatusChanged(status, error) {
                settingsSaveStatus.value = status;
                settingsSaveError.value = error ? getErrorMessage(error) : null;
            },
        });
        return settingsPersistenceQueue;
    }

    async function save() {
        cancelDebouncedSettingsSave();
        return getSettingsPersistenceQueue().save();
    }

    // Trailing debounce: per-keystroke updates otherwise write storage plus
    // two cookies (browser) or an IPC round-trip (desktop) on every change.
    // The queue reads the live snapshot at save time, so the flushed save
    // always persists the latest state.
    function scheduleDebouncedSave() {
        if (settingsSaveFlushListener === null && typeof window !== 'undefined') {
            settingsSaveFlushListener = () => flushDebouncedSettingsSave?.();
            window.addEventListener('pagehide', settingsSaveFlushListener);
        }
        if (settingsSaveDebounceTimer !== null) {
            clearTimeout(settingsSaveDebounceTimer);
        }
        flushDebouncedSettingsSave = () => {
            void save();
        };
        settingsSaveDebounceTimer = setTimeout(() => {
            settingsSaveDebounceTimer = null;
            const flush = flushDebouncedSettingsSave;
            flushDebouncedSettingsSave = null;
            flush?.();
        }, SETTINGS_SAVE_DEBOUNCE_MS);
    }

    function updateSetting<K extends keyof ISettingsData>(key: K, value: ISettingsData[K]) {
        settings.value = {
            ...settings.value,
            [key]: value,
        };
        scheduleDebouncedSave();
    }

    return {
        settings,
        isLoaded,
        hasCookieSnapshot: hasSettingsCookieSnapshot,
        isSettingsSavePendingRetry,
        load,
        save,
        settingsSaveError,
        settingsSaveStatus,
        updateSetting,
    };
};

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        cancelDebouncedSettingsSave();
        if (settingsSaveFlushListener !== null && typeof window !== 'undefined') {
            window.removeEventListener('pagehide', settingsSaveFlushListener);
            settingsSaveFlushListener = null;
        }
        settingsPersistenceQueue?.clearRetryTimer();
        settingsPersistenceQueue = null;
    });
}
