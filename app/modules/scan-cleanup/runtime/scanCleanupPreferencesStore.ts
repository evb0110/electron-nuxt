import type {IScanCleanupGlobalPreferences} from '@app/modules/scan-cleanup/persistence/preferencesSchema';
import type {EffectScope} from 'vue';
import {
    loadScanCleanupPreferences,
    saveScanCleanupPreferences,
} from '@app/modules/scan-cleanup/persistence/preferencesRepository';

let preferences: IScanCleanupGlobalPreferences | null = null;
let persistenceScope: EffectScope | null = null;

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
            saveScanCleanupPreferences(value);
        }, {deep: true});
    });
    return preferences;
}

export function dismissScanCleanupFirstRunGuidanceInStore() {
    getScanCleanupPreferencesStore().firstRunGuidanceDismissed = true;
}

/** Re-loads the singleton on its next access. Primarily useful for isolated tests. */
export function resetScanCleanupPreferencesStore() {
    persistenceScope?.stop();
    persistenceScope = null;
    preferences = null;
}
