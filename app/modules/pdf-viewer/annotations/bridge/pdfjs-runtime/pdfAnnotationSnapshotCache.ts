import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    ILinkAnnotation,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { estimateAnnotationSnapshotBytes } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/estimateAnnotationSnapshotBytes';

export type TPdfAnnotationNameReadResult = 'reconciled' | 'skipped' | 'failed';

export interface IPdfAnnotationSnapshot {
    doc: PDFDocumentProxy;
    pageCount: number;
    comments: IAnnotationCommentSummary[];
    links: ILinkAnnotation[];
    annotationNameReadResult: TPdfAnnotationNameReadResult;
    completeness: IAnnotationInventoryCompleteness;
}

export interface ISharedPdfAnnotationSnapshot {
    pageCount: number;
    comments: IAnnotationCommentSummary[];
    links: ILinkAnnotation[];
    annotationNameReadResult: TPdfAnnotationNameReadResult;
    completeness: IAnnotationInventoryCompleteness;
}

/**
 * One cached payload plus everything needed to un-cache it.
 *
 * An entry belongs to exactly one lookup tier: `key` identifies a revision, or
 * `docRef` identifies a PDF.js proxy, never both. A snapshot reachable from two
 * tiers could only be released by both of them agreeing to drop it, which is
 * how an evicted entry stays alive.
 *
 * `docRef` is weak so evicting a proxy-keyed entry can clear its WeakMap slot
 * without the cache pinning the document itself: a strong reference here would
 * trade a bounded snapshot leak for an unbounded one, since a PDFDocumentProxy
 * retains its worker-side page data.
 */
interface IPdfAnnotationSnapshotEntry {
    snapshot: ISharedPdfAnnotationSnapshot;
    estimatedBytes: number;
    key: string | null;
    docRef: WeakRef<PDFDocumentProxy> | null;
}

// Exported so the cache's own tests bind to the limits it enforces rather than
// restating them; production callers only ever go through the read/remember API.
// fallow-ignore-next-line unused-export
export const MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS = 8;

/**
 * Byte ceiling for everything this module retains, across both lookup tiers.
 *
 * A single background inventory can hold up to 25,000 records, and an ordinary
 * structured comment summary prices out near 600 bytes, so one worst-case
 * snapshot approaches 15 MB. Eight of those pinned across tabs and workspaces
 * is over 100 MB of module-global retention that nothing ever releases. 32 MiB
 * leaves ordinary documents (tens of KB each, so all eight slots stay filled)
 * untouched while capping the pathological case at roughly two large
 * snapshots. Anything larger than the whole budget is never admitted: it would
 * evict every other tenant and still not survive its own insertion.
 *
 * The proxy-keyed tier counts against the same budget. It is weak per entry,
 * but weakness only bounds retention for documents that have already been
 * collected; several open documents with no revision token are all live at
 * once, so without a shared budget that tier is exactly the unbounded side
 * channel the keyed LRU exists to prevent.
 */
// fallow-ignore-next-line unused-export
export const MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES = 32 * 1024 * 1024;

// Insertion order is LRU order: a hit deletes and re-adds its entry, so the
// first element is always the least recently used across both tiers.
const snapshotsByRecency = new Set<IPdfAnnotationSnapshotEntry>();
const keyedSnapshots = new Map<string, IPdfAnnotationSnapshotEntry>();
const docSnapshots = new WeakMap<PDFDocumentProxy, IPdfAnnotationSnapshotEntry>();
let retainedSnapshotBytes = 0;

function toSharedSnapshot(snapshot: IPdfAnnotationSnapshot): ISharedPdfAnnotationSnapshot {
    return {
        pageCount: snapshot.pageCount,
        comments: structuredClone(snapshot.comments),
        links: structuredClone(snapshot.links),
        annotationNameReadResult: snapshot.annotationNameReadResult,
        completeness: {
            ...snapshot.completeness,
            omissions: [...snapshot.completeness.omissions],
        },
    };
}

export function cloneSharedPdfAnnotationSnapshot(
    cached: ISharedPdfAnnotationSnapshot,
    doc: PDFDocumentProxy,
): IPdfAnnotationSnapshot {
    return {
        doc,
        pageCount: cached.pageCount,
        comments: structuredClone(cached.comments),
        links: structuredClone(cached.links),
        annotationNameReadResult: cached.annotationNameReadResult,
        completeness: {
            ...cached.completeness,
            omissions: [...cached.completeness.omissions],
        },
    };
}

/**
 * Release an entry from the recency order, its lookup tier, and the budget.
 *
 * Each tier is checked for identity, not just for the presence of a slot: a
 * replacement that already took the key or the proxy owns that slot, and
 * deleting it here would strand the live snapshot in the recency order.
 */
function releaseSnapshotEntry(entry: IPdfAnnotationSnapshotEntry) {
    if (!snapshotsByRecency.delete(entry)) {
        return;
    }
    retainedSnapshotBytes -= entry.estimatedBytes;

    if (entry.key !== null && keyedSnapshots.get(entry.key) === entry) {
        keyedSnapshots.delete(entry.key);
    }

    const doc = entry.docRef?.deref() ?? null;
    if (doc && docSnapshots.get(doc) === entry) {
        docSnapshots.delete(doc);
    }
}

function dropKeyedSnapshot(key: string) {
    const existing = keyedSnapshots.get(key);
    if (existing) {
        releaseSnapshotEntry(existing);
    }
}

function dropDocSnapshot(doc: PDFDocumentProxy) {
    const existing = docSnapshots.get(doc);
    if (existing) {
        releaseSnapshotEntry(existing);
    }
}

/**
 * Hand the budget back the bytes of snapshots whose document is already gone.
 *
 * The WeakMap slot disappears with its proxy, but this module's byte total and
 * recency order do not, so a closed document would keep evicting live tenants
 * until it aged out on its own. The scan is bounded by the entry ceiling.
 */
function releaseCollectedDocSnapshots() {
    for (const entry of [...snapshotsByRecency]) {
        if (entry.docRef && entry.docRef.deref() === undefined) {
            releaseSnapshotEntry(entry);
        }
    }
}

function evictSnapshotsToBudget() {
    while (
        snapshotsByRecency.size > MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS
        || retainedSnapshotBytes > MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES
    ) {
        const oldest = snapshotsByRecency.values().next().value;
        if (oldest === undefined) {
            // Nothing left to release, so any residual total is accounting
            // drift rather than retained memory.
            retainedSnapshotBytes = 0;
            return;
        }
        releaseSnapshotEntry(oldest);
    }
}

function touchSnapshotEntry(entry: IPdfAnnotationSnapshotEntry) {
    snapshotsByRecency.delete(entry);
    snapshotsByRecency.add(entry);
}

/**
 * Read a reusable snapshot for a revision key or the exact PDF.js proxy.
 *
 * The two lookups answer different questions and must never substitute for
 * each other. A caller that supplies a revision key is asking for that exact
 * revision, so a keyed miss is a miss: the proxy-keyed tier may still hold the
 * snapshot taken before the document was edited, and serving it would hand
 * back a stale inventory under a fresh revision's name. The proxy tier is
 * consulted only when there is no revision token to identify by, where proxy
 * identity is the only identity available.
 */
export function readSharedPdfAnnotationSnapshot(
    key: string | null,
    doc: PDFDocumentProxy,
): ISharedPdfAnnotationSnapshot | null {
    const entry = key ? keyedSnapshots.get(key) : docSnapshots.get(doc);
    if (!entry) {
        return null;
    }

    touchSnapshotEntry(entry);
    return entry.snapshot;
}

/**
 * Publish a completed snapshot to exactly one reuse path.
 *
 * A revision key identifies the payload better than the proxy does, so a keyed
 * snapshot is stored keyed and nowhere else. Mirroring it into the proxy tier
 * would put the same payload behind a reference the LRU cannot evict: the
 * entry would survive eviction, the byte budget, and the entry ceiling for as
 * long as the PDF.js proxy lives, which is the leak all three exist to stop.
 *
 * Byte accounting runs once, on the source arrays, before any clone exists, so
 * an over-budget payload is rejected without ever being copied. Whatever was
 * cached for this key or this proxy is dropped first, including when the new
 * payload is rejected: the previous snapshot describes an older inventory, and
 * leaving it in place would let a rejected refresh be served as if it were
 * current. The proxy entry is dropped even on the keyed path, because this
 * document's inventory has just been superseded no matter which tier answered
 * for it last time.
 */
export function rememberPdfAnnotationSnapshot(
    key: string | null,
    doc: PDFDocumentProxy,
    snapshot: IPdfAnnotationSnapshot,
) {
    const estimatedBytes = estimateAnnotationSnapshotBytes(snapshot);
    // An empty revision token identifies nothing, so it is a keyless write
    // rather than an entry filed under the empty string.
    const revisionKey = key === '' ? null : key;

    releaseCollectedDocSnapshots();
    if (revisionKey) {
        dropKeyedSnapshot(revisionKey);
    }
    dropDocSnapshot(doc);

    if (estimatedBytes > MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES) {
        return;
    }

    // Readers copy on the way out, so the stored entry is never mutated in
    // place and one clone serves every consumer of this snapshot.
    const entry: IPdfAnnotationSnapshotEntry = {
        snapshot: toSharedSnapshot(snapshot),
        estimatedBytes,
        key: revisionKey,
        docRef: revisionKey ? null : new WeakRef(doc),
    };

    if (revisionKey) {
        keyedSnapshots.set(revisionKey, entry);
    }
    else {
        docSnapshots.set(doc, entry);
    }
    snapshotsByRecency.add(entry);
    retainedSnapshotBytes += estimatedBytes;
    evictSnapshotsToBudget();
}
