import type {
    IDebugLogEntry,
    IRendererLogEntry,
    ISettingsCapability,
} from '@contracts/platform-api';
import type { ISettingsData } from '@contracts/shared';
import {
    DEFAULT_SETTINGS,
    sanitizeSettings,
} from '@contracts/settings';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/local-storage';
import {
    SETTINGS_STORAGE_KEY,
    noopUnsubscribe,
} from '@app/platform/browser-api/common';

const settingsState = ref<ISettingsData>({ ...DEFAULT_SETTINGS });
let browserSettingsLoaded = false;

function readBrowserSettingsFromStorage() {
    const raw = safeGetLocalStorageItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
        return { ...DEFAULT_SETTINGS };
    }

    try {
        return sanitizeSettings(JSON.parse(raw) as ISettingsData);
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function writeBrowserSettingsToStorage(nextSettings: ISettingsData) {
    safeSetLocalStorageItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings));
}

export const browserSettingsCapability: ISettingsCapability = {
    get() {
        if (!browserSettingsLoaded) {
            settingsState.value = readBrowserSettingsFromStorage();
            browserSettingsLoaded = true;
        }

        return Promise.resolve(sanitizeSettings(settingsState.value));
    },
    save(settings) {
        const nextSettings = sanitizeSettings(settings);
        settingsState.value = nextSettings;
        browserSettingsLoaded = true;
        writeBrowserSettingsToStorage(nextSettings);
        return Promise.resolve();
    },
    getDebugLogs(): Promise<IDebugLogEntry[]> {
        return Promise.resolve([]);
    },
    rendererLog(_entry: IRendererLogEntry) {},
    onMenuOpenSettings: noopUnsubscribe,
};
