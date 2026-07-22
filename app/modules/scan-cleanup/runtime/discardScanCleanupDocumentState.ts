import {discardScanCleanupDetectionState} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';
import {resetScanCleanupDocumentOverrides} from '@app/modules/scan-cleanup/persistence/preferencesRepository';

/**
 * Closing the scan-cleanup surface discards the split session for a document:
 * in-memory detection restore state and persisted page overrides are dropped,
 * so re-entering starts a fresh detection pass. Document margins and global
 * preferences survive as editing defaults.
 */
export function discardScanCleanupDocumentState(documentKey: string | null | undefined) {
    if (!documentKey) {
        return;
    }
    discardScanCleanupDetectionState(documentKey);
    resetScanCleanupDocumentOverrides(documentKey);
}
