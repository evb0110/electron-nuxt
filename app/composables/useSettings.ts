
import {
    DEFAULT_SETTINGS,
    sanitizeSettings,
} from '@app/shared/settings-sanitizer';
import type { ISettingsData } from '@app/types/shared';
import { BrowserLogger } from '@app/utils/browser-logger';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';

// Vite HMR types (not exposed by Nuxt's type system)
declare global {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting built-in ImportMeta
    interface ImportMeta {hot?: {
        data?: Record<string, unknown>;
        dispose: (callback: (data: Record<string, unknown>) => void) => void;
    };}
}

// Shared state across all composable instances
const settings = ref<ISettingsData>({ ...DEFAULT_SETTINGS });
const isLoaded = ref(false);

// Deduplication: track in-flight load promise
let loadPromise: Promise<void> | null = null;

export const useSettings = () => {

    async function load() {
        if (!hasElectronAPI()) {
            return;
        }

        // Deduplicate: if already loading, return existing promise
        if (loadPromise) {
            return loadPromise;
        }

        loadPromise = (async () => {
            try {
                const loadedSettings = await getElectronAPI().settings.get();
                settings.value = sanitizeSettings(loadedSettings);
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
        if (!hasElectronAPI()) {
            return;
        }

        try {
            const payload = sanitizeSettings(toRaw(settings.value));
            await getElectronAPI().settings.save(payload);
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
        load,
        save,
        updateSetting,
    };
};

// HMR support: preserve and restore state across hot updates
if (import.meta.hot) {
    import.meta.hot.dispose((data) => {
        data.settings = settings.value;
        data.isLoaded = isLoaded.value;
    });

    const hmrData = import.meta.hot.data;
    if (hmrData?.settings) {
        settings.value = hmrData.settings as ISettingsData;
        isLoaded.value = (hmrData.isLoaded as boolean) ?? false;
    }
}
