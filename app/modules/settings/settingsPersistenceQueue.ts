import {
    SETTINGS_SAVE_KEYS,
    sanitizeSettings,
    type TSettingsSavePatch,
} from '@contracts/settings';
import type { ISettingsData } from '@contracts/shared';

const SETTINGS_SAVE_RETRY_INITIAL_DELAY_MS = 1_000;
const SETTINGS_SAVE_RETRY_MAX_DELAY_MS = 30_000;

type TSettingsSaveTimer = ReturnType<typeof setTimeout>;
export type TSettingsPersistenceStatus = 'idle' | 'saving' | 'retry-pending';

export interface ISettingsPersistenceScheduler {
    setTimeout: (callback: () => void, delayMs: number) => TSettingsSaveTimer;
    clearTimeout: (timer: TSettingsSaveTimer) => void;
}

export interface ISettingsPersistenceQueueOptions {
    getSettingsSnapshot: () => unknown;
    getLastSavedSettings: () => ISettingsData | null;
    savePatch: (patch: TSettingsSavePatch) => Promise<void>;
    onSaved: (settings: ISettingsData) => void;
    onSaveError: (error: unknown) => void;
    onStatusChanged?: (status: TSettingsPersistenceStatus, error?: unknown) => void;
    scheduler?: ISettingsPersistenceScheduler;
    retryInitialDelayMs?: number;
    retryMaxDelayMs?: number;
}

export interface ISettingsPersistenceQueue {
    save: () => Promise<boolean>;
    clearRetryTimer: () => void;
    hasRetryScheduled: () => boolean;
}

const DEFAULT_SETTINGS_PERSISTENCE_SCHEDULER: ISettingsPersistenceScheduler = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: timer => clearTimeout(timer),
};

export function buildSettingsPatch(
    previousSettings: ISettingsData | null,
    nextSettings: ISettingsData,
) {
    const patch: TSettingsSavePatch = {};
    for (const key of SETTINGS_SAVE_KEYS) {
        if (
            Object.hasOwn(nextSettings, key)
            && (!previousSettings || nextSettings[key] !== previousSettings[key])
        ) {
            Object.assign(patch, {[key]: nextSettings[key]});
        }
    }
    return patch;
}

export function createSettingsPersistenceQueue(
    options: ISettingsPersistenceQueueOptions,
): ISettingsPersistenceQueue {
    const scheduler = options.scheduler ?? DEFAULT_SETTINGS_PERSISTENCE_SCHEDULER;
    const retryInitialDelayMs = options.retryInitialDelayMs ?? SETTINGS_SAVE_RETRY_INITIAL_DELAY_MS;
    const retryMaxDelayMs = options.retryMaxDelayMs ?? SETTINGS_SAVE_RETRY_MAX_DELAY_MS;
    let saveInFlight: Promise<boolean> | null = null;
    let saveDirty = false;
    let saveRetryTimer: TSettingsSaveTimer | null = null;
    let saveRetryDelayMs = retryInitialDelayMs;

    function setStatus(status: TSettingsPersistenceStatus, error?: unknown) {
        options.onStatusChanged?.(status, error);
    }

    function clearRetryTimer() {
        if (!saveRetryTimer) {
            return;
        }
        scheduler.clearTimeout(saveRetryTimer);
        saveRetryTimer = null;
    }

    function scheduleSaveRetry() {
        if (saveRetryTimer) {
            return;
        }
        saveRetryTimer = scheduler.setTimeout(() => {
            saveRetryTimer = null;
            void save();
        }, saveRetryDelayMs);
        saveRetryDelayMs = Math.min(saveRetryDelayMs * 2, retryMaxDelayMs);
    }

    async function runSaveQueue() {
        while (true) {
            saveDirty = false;
            const payload = sanitizeSettings(options.getSettingsSnapshot());
            const patch = buildSettingsPatch(options.getLastSavedSettings(), payload);
            try {
                if (Object.keys(patch).length > 0) {
                    await options.savePatch(patch);
                }
                options.onSaved(payload);
                saveRetryDelayMs = retryInitialDelayMs;
            } catch (error) {
                options.onSaveError(error);
                saveDirty = true;
                scheduleSaveRetry();
                setStatus('retry-pending', error);
                return false;
            }

            if (!saveDirty) {
                setStatus('idle');
                return true;
            }
        }
    }

    async function save() {
        if (saveInFlight) {
            saveDirty = true;
            return saveInFlight;
        }

        clearRetryTimer();
        setStatus('saving');
        saveInFlight = runSaveQueue().finally(() => {
            saveInFlight = null;
        });
        return saveInFlight;
    }

    return {
        save,
        clearRetryTimer,
        hasRetryScheduled: () => saveRetryTimer !== null,
    };
}
