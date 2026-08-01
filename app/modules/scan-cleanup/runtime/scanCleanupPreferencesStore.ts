import type {IScanCleanupGlobalPreferences} from '@app/modules/scan-cleanup/persistence/preferencesSchema';
import type {EffectScope} from 'vue';
import {
    loadScanCleanupPreferences,
    saveScanCleanupPreferences,
    SCAN_CLEANUP_PREFERENCES_PERSISTENCE_DEBOUNCE_MS,
} from '@app/modules/scan-cleanup/persistence/preferencesRepository';

let preferences: IScanCleanupGlobalPreferences | null = null;
let persistenceScope: EffectScope | null = null;
let persistenceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPreferences: IScanCleanupGlobalPreferences | null = null;
let lifecycleListenersRegistered = false;

function scheduleScanCleanupPreferencesPersistence(value: IScanCleanupGlobalPreferences) {
    pendingPreferences = value;
    if (persistenceTimer !== null) clearTimeout(persistenceTimer);
    persistenceTimer = setTimeout(flushScanCleanupPreferencesStore, SCAN_CLEANUP_PREFERENCES_PERSISTENCE_DEBOUNCE_MS);
}

export function flushScanCleanupPreferencesStore() {
    if (persistenceTimer !== null) {
        clearTimeout(persistenceTimer);
        persistenceTimer = null;
    }
    const pending = pendingPreferences;
    pendingPreferences = null;
    if (pending) saveScanCleanupPreferences(pending);
}

function handleWindowLifecycle() {
    flushScanCleanupPreferencesStore();
}

function registerLifecycleListeners() {
    if (lifecycleListenersRegistered || typeof window === 'undefined') {
        return;
    }
    lifecycleListenersRegistered = true;
    window.addEventListener('beforeunload', handleWindowLifecycle);
    window.addEventListener('pagehide', handleWindowLifecycle);
}

function unregisterLifecycleListeners() {
    if (!lifecycleListenersRegistered || typeof window === 'undefined') {
        return;
    }
    lifecycleListenersRegistered = false;
    window.removeEventListener('beforeunload', handleWindowLifecycle);
    window.removeEventListener('pagehide', handleWindowLifecycle);
}

/** Renderer-wide global preferences shared by every mounted scan-cleanup surface. */
export function getScanCleanupPreferencesStore() {
    if (preferences) {
        return preferences;
    }
    const sharedPreferences = reactive(loadScanCleanupPreferences());
    preferences = sharedPreferences;
    persistenceScope = effectScope(true);
    persistenceScope.run(() => {
        watch(sharedPreferences, value => {
            scheduleScanCleanupPreferencesPersistence(value);
        }, {deep: true});
    });
    registerLifecycleListeners();
    return preferences;
}

export function dismissScanCleanupFirstRunGuidanceInStore() {
    getScanCleanupPreferencesStore().firstRunGuidanceDismissed = true;
}

/** Re-loads the singleton on its next access. Primarily useful for isolated tests. */
export function resetScanCleanupPreferencesStore() {
    flushScanCleanupPreferencesStore();
    persistenceScope?.stop();
    persistenceScope = null;
    unregisterLifecycleListeners();
    preferences = null;
}
