import type {
    IAnnotationInventoryCompleteness,
    TAnnotationInventoryOmission,
} from '@app/types/annotations';
import { BrowserLogger } from '@app/utils/browserLogger';

/**
 * Ceilings on one background inventory pass, exported so the tests that cover
 * the truncation behaviour bind to the same numbers the scan enforces instead
 * of restating them.
 */
export const MAX_BACKGROUND_PDF_ANNOTATION_PAGES = 5_000;
export const MAX_BACKGROUND_PDF_ANNOTATION_RECORDS = 25_000;

const COMPLETE_INVENTORY_OMISSIONS: readonly TAnnotationInventoryOmission[] = Object.freeze([]);

/**
 * Page read failures are transient, so a snapshot that hit one is worth one
 * more scan. Both caps are deterministic for a given revision: rescanning
 * truncates at exactly the same place, so retrying only burns the UI thread.
 */
function isRetryableInventoryCompleteness(completeness: IAnnotationInventoryCompleteness) {
    return completeness.failedPageCount > 0;
}

/**
 * Warn, not debug: the default renderer log threshold is `warn`, and an
 * inventory that silently omits pages is exactly the thing a user reporting
 * "my annotations are missing" needs to see in a log.
 */
function warnOnIncompleteInventory(completeness: IAnnotationInventoryCompleteness) {
    if (completeness.complete) {
        return;
    }

    BrowserLogger.warn(
        'annotations',
        'Background annotation inventory is incomplete',
        {
            omissions: completeness.omissions,
            scannedPageCount: completeness.scannedPageCount,
            totalPageCount: completeness.totalPageCount,
            failedPageCount: completeness.failedPageCount,
        },
    );
}

/**
 * Turn one scan's tally into the record every consumer reads, and report the
 * omission on the way out. Building and logging are one step because a
 * completeness record that nobody logged is exactly the silent truncation the
 * record exists to expose.
 */
export function resolveAnnotationInventoryCompleteness(scan: {
    omissions: ReadonlySet<TAnnotationInventoryOmission>;
    visitedPageCount: number;
    failedPageCount: number;
    totalPageCount: number;
}): IAnnotationInventoryCompleteness {
    const completeness: IAnnotationInventoryCompleteness = {
        complete: scan.omissions.size === 0,
        omissions: scan.omissions.size === 0 ? COMPLETE_INVENTORY_OMISSIONS : [...scan.omissions],
        scannedPageCount: scan.visitedPageCount - scan.failedPageCount,
        totalPageCount: scan.totalPageCount,
        failedPageCount: scan.failedPageCount,
    };
    warnOnIncompleteInventory(completeness);
    return completeness;
}

/**
 * Tracks how much rescanning one incomplete inventory has already earned.
 *
 * A cached snapshot that lost pages to a transient read failure is discarded
 * once per snapshot generation, so the next sync rescans and can recover the
 * missing pages. Anything that bumps the generation (new document, new
 * revision, explicit invalidation) re-arms the retry, and within one
 * generation the retry is spent once, so a permanently unreadable page cannot
 * turn every sync into a full rescan.
 */
export function createIncompleteInventoryRetryLedger(getSnapshotVersion: () => number) {
    let retriedSnapshotVersion: number | null = null;

    function hasPendingRetry(completeness: IAnnotationInventoryCompleteness) {
        return !completeness.complete
            && isRetryableInventoryCompleteness(completeness)
            && retriedSnapshotVersion !== getSnapshotVersion();
    }

    /**
     * The gate is per lookup: once a lookup decides to rescan, every other
     * cache tier in the same lookup has to agree, or the discarded snapshot
     * would come straight back from the next tier.
     */
    function createGate() {
        let retryTaken = false;
        return function shouldDiscardIncompleteSnapshot(
            completeness: IAnnotationInventoryCompleteness,
        ) {
            if (completeness.complete || !isRetryableInventoryCompleteness(completeness)) {
                return false;
            }
            if (retryTaken) {
                return true;
            }
            if (!hasPendingRetry(completeness)) {
                return false;
            }

            retriedSnapshotVersion = getSnapshotVersion();
            retryTaken = true;
            return true;
        };
    }

    function reset() {
        retriedSnapshotVersion = null;
    }

    return {
        hasPendingRetry,
        createGate,
        reset,
    };
}
