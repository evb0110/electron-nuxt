import {discardScanCleanupDetectionState} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';
import {resetScanCleanupDocumentOverrides} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {saveScanCleanupDocumentPreferencesInStore} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';

/**
 * Closing the scan-cleanup surface discards the split session for a document:
 * in-memory detection restore state and persisted page overrides are dropped,
 * so re-entering starts a fresh detection pass. Document margins and global
 * preferences survive as editing defaults. Desktop preferences live in the
 * main-process settings file keyed by source hash, so the same reset must
 * reach that store too — the browser repository alone only covers the legacy
 * localStorage entry.
 */
export function discardScanCleanupDocumentState(
    documentKey: string | null | undefined,
    sourceSha256?: string | null,
) {
    if (!documentKey && !sourceSha256) {
        return;
    }
    if (documentKey) {
        discardScanCleanupDetectionState(documentKey);
        resetScanCleanupDocumentOverrides(documentKey);
    }
    if (sourceSha256) {
        saveScanCleanupDocumentPreferencesInStore(
            sourceSha256,
            documentKey ?? null,
            {resetOverrides: true},
        );
    }
}
