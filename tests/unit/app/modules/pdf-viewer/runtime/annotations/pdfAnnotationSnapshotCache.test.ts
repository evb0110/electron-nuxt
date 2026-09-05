import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
} from '@app/types/annotations';
import type {PDFDocumentProxy} from '@app/types/pdfContracts';
import { estimateAnnotationSnapshotBytes } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/estimateAnnotationSnapshotBytes';
import {createPdfDocumentProxy} from '@tests/helpers/createPdfDocumentProxy';

import type {
    IPdfAnnotationSnapshot,
    ISharedPdfAnnotationSnapshot,
} from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/pdfAnnotationSnapshotCache';
import type * as PdfAnnotationSnapshotCacheModule from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/pdfAnnotationSnapshotCache';

type TCacheModule = typeof PdfAnnotationSnapshotCacheModule;

const COMPLETE: IAnnotationInventoryCompleteness = {
    complete: true,
    omissions: [],
    scannedPageCount: 1,
    totalPageCount: 1,
    failedPageCount: 0,
};

// Large enough that a handful of entries crosses the 32 MiB budget, so byte
// eviction can be exercised before the eight-entry ceiling ever trips.
const LARGE_TEXT_LENGTH = 100_000;
const LARGE_COMMENT_COUNT = 80;

function createComment(index: number, textLength: number): IAnnotationCommentSummary {
    return {
        id: `comment-${index}`,
        stableKey: `src:pdf:0:${index}` as const,
        sortIndex: index,
        pageIndex: 0,
        pageNumber: 1,
        text: 'x'.repeat(textLength),
        displayText: '',
        previewText: '',
        kindLabel: 'Note',
        subtype: 'FreeText',
        author: null,
        createdAt: null,
        modifiedAt: null,
        color: '#ef4444',
        uid: null,
        annotationId: `annotation-${index}`,
        source: 'pdf',
        hasNote: false,
        markerRect: null,
    };
}

function createSnapshot(options: {
    doc: PDFDocumentProxy;
    commentCount: number;
    textLength: number;
}): IPdfAnnotationSnapshot {
    return {
        doc: options.doc,
        pageCount: 1,
        identity: 'document',
        revision: null,
        comments: Array.from(
            { length: options.commentCount },
            (_unused, index) => createComment(index, options.textLength),
        ),
        links: [],
        annotationNameReadResult: 'skipped' as const,
        annotationNameSkipReason: null,
        completeness: COMPLETE,
    };
}

function createLargeSnapshot(doc: PDFDocumentProxy): IPdfAnnotationSnapshot {
    return createSnapshot({
        doc,
        commentCount: LARGE_COMMENT_COUNT,
        textLength: LARGE_TEXT_LENGTH,
    });
}

function documentAt(docs: readonly PDFDocumentProxy[], index: number): PDFDocumentProxy {
    const doc = docs[index];
    if (doc === undefined) {
        throw new Error(`Missing test document at index ${String(index)}`);
    }
    return doc;
}

function largeSnapshotBytes() {
    return estimateAnnotationSnapshotBytes(createLargeSnapshot(createPdfDocumentProxy()));
}

let cache: TCacheModule;

beforeEach(async () => {
    // The LRU is module-global by design; a fresh module instance is the only
    // honest reset.
    vi.resetModules();
    cache = await import('@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/pdfAnnotationSnapshotCache');
});

describe('pdfAnnotationSnapshotCache', () => {
    it('keeps every small-document entry within both the count and byte limits', () => {
        const docs = Array.from({ length: cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS }, () => createPdfDocumentProxy());
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc,
                createSnapshot({
                    doc,
                    commentCount: 4,
                    textLength: 32,
                }),
            );
        });

        docs.forEach((_doc, index) => {
            // Read with a foreign proxy so only the revision-keyed LRU can
            // answer; the document tier must not mask an eviction.
            const hit = cache.readSharedPdfAnnotationSnapshot(`revision-${index}`, createPdfDocumentProxy());
            expect(hit?.comments).toHaveLength(4);
        });
    });

    it('still evicts by count when small entries never approach the byte budget', () => {
        const docs = Array.from({ length: cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS + 1 }, () => createPdfDocumentProxy());
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc,
                createSnapshot({
                    doc,
                    commentCount: 4,
                    textLength: 32,
                }),
            );
        });

        // Byte accounting is an added bound, not a replacement: a stream of
        // tiny snapshots stays far under the budget, so only the count ceiling
        // keeps the module-global map from growing without limit.
        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', createPdfDocumentProxy())).toBeNull();
        for (let index = 1; index < docs.length; index += 1) {
            expect(cache.readSharedPdfAnnotationSnapshot(`revision-${index}`, createPdfDocumentProxy())).not.toBeNull();
        }
    });

    it('evicts the oldest entries when the byte budget is exceeded before the count limit', () => {
        const entryBytes = largeSnapshotBytes();
        const budget = cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES;
        const fittingEntries = Math.floor(budget / entryBytes);

        expect(entryBytes).toBeLessThan(budget);
        expect(fittingEntries).toBeGreaterThanOrEqual(1);
        expect(fittingEntries).toBeLessThan(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS);

        const docs = Array.from({ length: fittingEntries + 1 }, () => createPdfDocumentProxy());
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc,
                createLargeSnapshot(doc),
            );
        });

        // The oldest entry is gone even though the entry count never reached
        // the eight-snapshot ceiling.
        const evictedDoc = createPdfDocumentProxy();
        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', evictedDoc)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(
            `revision-${docs.length - 1}`,
            createPdfDocumentProxy(),
        )).not.toBeNull();
    });

    it('refreshes recency on a hit so the least recently used entry is evicted first', () => {
        const entryBytes = largeSnapshotBytes();
        const fittingEntries = Math.floor(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES / entryBytes);
        expect(fittingEntries).toBeGreaterThanOrEqual(2);

        const docs = Array.from({ length: fittingEntries }, () => createPdfDocumentProxy());
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc,
                createLargeSnapshot(doc),
            );
        });

        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', createPdfDocumentProxy())).not.toBeNull();

        const extraDoc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(
            'revision-extra',
            extraDoc,
            createLargeSnapshot(extraDoc),
        );

        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', createPdfDocumentProxy())).not.toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot('revision-1', createPdfDocumentProxy())).toBeNull();
    });

    it('refreshes recency for a proxy-keyed hit too', () => {
        const entryBytes = largeSnapshotBytes();
        const fittingEntries = Math.floor(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES / entryBytes);
        expect(fittingEntries).toBeGreaterThanOrEqual(2);

        const docs = Array.from({ length: fittingEntries }, () => createPdfDocumentProxy());
        docs.forEach((doc) => {
            cache.rememberPdfAnnotationSnapshot(null, doc, createLargeSnapshot(doc));
        });

        expect(cache.readSharedPdfAnnotationSnapshot(null, documentAt(docs, 0))).not.toBeNull();

        const extraDoc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(null, extraDoc, createLargeSnapshot(extraDoc));

        // Both tiers share one recency order, so a proxy-keyed read has to
        // protect its entry the same way a keyed read does.
        expect(cache.readSharedPdfAnnotationSnapshot(null, documentAt(docs, 0))).not.toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(null, documentAt(docs, 1))).toBeNull();
    });

    it('never retains a single snapshot larger than the whole budget', () => {
        const smallDoc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(
            'revision-small',
            smallDoc,
            createSnapshot({
                doc: smallDoc,
                commentCount: 2,
                textLength: 16,
            }),
        );

        const hugeDoc = createPdfDocumentProxy();
        const huge = createSnapshot({
            doc: hugeDoc,
            commentCount: 200,
            textLength: LARGE_TEXT_LENGTH,
        });
        expect(estimateAnnotationSnapshotBytes(huge))
            .toBeGreaterThan(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES);

        cache.rememberPdfAnnotationSnapshot('revision-huge', hugeDoc, huge);

        expect(cache.readSharedPdfAnnotationSnapshot('revision-huge', createPdfDocumentProxy())).toBeNull();
        // Rejecting the oversized payload must not cost the existing tenants.
        expect(cache.readSharedPdfAnnotationSnapshot('revision-small', createPdfDocumentProxy())).not.toBeNull();
    });

    it('replaces an entry under the same key without leaking its byte accounting', () => {
        const doc = createPdfDocumentProxy();
        const fittingEntries = Math.floor(
            cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES / largeSnapshotBytes(),
        );

        for (let attempt = 0; attempt < fittingEntries + 3; attempt += 1) {
            cache.rememberPdfAnnotationSnapshot(
                'revision-stable',
                doc,
                createLargeSnapshot(doc),
            );
        }

        expect(cache.readSharedPdfAnnotationSnapshot('revision-stable', createPdfDocumentProxy())).not.toBeNull();
    });

    it('frees the whole budget when repeated replacement is the only traffic', () => {
        const doc = createPdfDocumentProxy();
        for (let attempt = 0; attempt < 6; attempt += 1) {
            cache.rememberPdfAnnotationSnapshot(
                'revision-stable',
                doc,
                createLargeSnapshot(doc),
            );
        }

        // Replacement releases the superseded bytes, so the budget still has
        // room for as many other tenants as it did before the churn.
        const entryBytes = largeSnapshotBytes();
        const remainingSlots = Math.floor(
            cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES / entryBytes,
        ) - 1;
        expect(remainingSlots).toBeGreaterThanOrEqual(1);

        const docs = Array.from({ length: remainingSlots }, () => createPdfDocumentProxy());
        docs.forEach((otherDoc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-other-${index}`,
                otherDoc,
                createLargeSnapshot(otherDoc),
            );
        });

        expect(cache.readSharedPdfAnnotationSnapshot('revision-stable', createPdfDocumentProxy())).not.toBeNull();
        docs.forEach((_doc, index) => {
            expect(cache.readSharedPdfAnnotationSnapshot(`revision-other-${index}`, createPdfDocumentProxy()))
                .not.toBeNull();
        });
    });

    it('falls back to the document-keyed snapshot when there is no revision key', () => {
        const doc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(
            null,
            doc,
            createSnapshot({
                doc,
                commentCount: 3,
                textLength: 8,
            }),
        );

        expect(cache.readSharedPdfAnnotationSnapshot(null, doc)?.comments).toHaveLength(3);
        expect(cache.readSharedPdfAnnotationSnapshot(null, createPdfDocumentProxy())).toBeNull();
    });

    it('treats an empty revision token as no key at all', () => {
        const doc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(
            '',
            doc,
            createSnapshot({
                doc,
                commentCount: 2,
                textLength: 8,
            }),
        );

        // An empty token identifies no revision, so filing the entry under it
        // would create a key every document without a token collides on.
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc)?.comments).toHaveLength(2);
        expect(cache.readSharedPdfAnnotationSnapshot('', doc)?.comments).toHaveLength(2);
        expect(cache.readSharedPdfAnnotationSnapshot(null, createPdfDocumentProxy())).toBeNull();
    });

    it('treats a keyed miss as a miss instead of serving the proxy fallback', () => {
        const doc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(
            'revision-before-edit',
            doc,
            createSnapshot({
                doc,
                commentCount: 5,
                textLength: 8,
            }),
        );

        // Same PDF.js proxy, next revision token: the cached payload describes
        // the pre-edit inventory, so the new revision must miss outright.
        expect(cache.readSharedPdfAnnotationSnapshot('revision-after-edit', doc)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot('revision-before-edit', doc)?.comments)
            .toHaveLength(5);
    });

    it('does not answer a keyed read with a snapshot stored without a key', () => {
        const doc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(
            null,
            doc,
            createSnapshot({
                doc,
                commentCount: 7,
                textLength: 8,
            }),
        );

        expect(cache.readSharedPdfAnnotationSnapshot('revision-any', doc)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc)?.comments).toHaveLength(7);
    });

    it('keeps a keyed snapshot out of the proxy tier entirely', () => {
        const doc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(
            'revision-keyed-only',
            doc,
            createSnapshot({
                doc,
                commentCount: 6,
                textLength: 8,
            }),
        );

        // Mirroring a keyed payload into the proxy tier would keep it alive
        // for as long as the PDF.js proxy lives, outside the entry ceiling and
        // the byte budget that the keyed LRU enforces.
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot('revision-keyed-only', doc)?.comments)
            .toHaveLength(6);
    });

    it('supersedes a proxy-tier snapshot when the same document is cached under a key', () => {
        const doc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(
            null,
            doc,
            createSnapshot({
                doc,
                commentCount: 3,
                textLength: 8,
            }),
        );
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc)).not.toBeNull();

        cache.rememberPdfAnnotationSnapshot(
            'revision-1',
            doc,
            createSnapshot({
                doc,
                commentCount: 9,
                textLength: 8,
            }),
        );

        // The keyless entry describes an inventory this document has already
        // moved past, so a later keyless lookup must not resurrect it.
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot('revision-1', doc)?.comments)
            .toHaveLength(9);
    });

    it('leaves a count-evicted keyed snapshot unreachable through every lookup', () => {
        const docs = Array.from({ length: cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS + 1 }, () => createPdfDocumentProxy());
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc,
                createSnapshot({
                    doc,
                    commentCount: 4,
                    textLength: 32,
                }),
            );
        });

        // Eviction is what releases the payload. If any tier still answers for
        // the evicted document, the snapshot is still reachable and therefore
        // still retained, whatever the byte total claims.
        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', documentAt(docs, 0))).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(null, documentAt(docs, 0))).toBeNull();
    });

    it('does not answer a keyed read with an evicted entry via the proxy fallback', () => {
        const entryBytes = largeSnapshotBytes();
        const fittingEntries = Math.floor(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES / entryBytes);

        const docs = Array.from({ length: fittingEntries + 1 }, () => createPdfDocumentProxy());
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc,
                createLargeSnapshot(doc),
            );
        });

        // Reading the evicted tenant by key or by proxy must not resurrect
        // what the byte budget just released.
        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', documentAt(docs, 0))).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(null, documentAt(docs, 0))).toBeNull();
    });

    it('declines to cache an oversized snapshot stored without a key', () => {
        const doc = createPdfDocumentProxy();
        const huge = createSnapshot({
            doc,
            commentCount: 200,
            textLength: LARGE_TEXT_LENGTH,
        });
        expect(estimateAnnotationSnapshotBytes(huge))
            .toBeGreaterThan(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES);

        cache.rememberPdfAnnotationSnapshot(null, doc, huge);

        expect(cache.readSharedPdfAnnotationSnapshot(null, doc)).toBeNull();
    });

    it('skips the proxy write too when a keyed snapshot is over budget', () => {
        const doc = createPdfDocumentProxy();
        const huge = createSnapshot({
            doc,
            commentCount: 200,
            textLength: LARGE_TEXT_LENGTH,
        });

        cache.rememberPdfAnnotationSnapshot('revision-huge', doc, huge);

        expect(cache.readSharedPdfAnnotationSnapshot('revision-huge', doc)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc)).toBeNull();
    });

    it('drops a stale keyless snapshot when its replacement is rejected as oversized', () => {
        const doc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(
            null,
            doc,
            createSnapshot({
                doc,
                commentCount: 2,
                textLength: 8,
            }),
        );
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc)).not.toBeNull();

        cache.rememberPdfAnnotationSnapshot(
            null,
            doc,
            createSnapshot({
                doc,
                commentCount: 200,
                textLength: LARGE_TEXT_LENGTH,
            }),
        );

        expect(cache.readSharedPdfAnnotationSnapshot(null, doc)).toBeNull();
    });

    it('holds keyless snapshots to the shared byte budget across live documents', () => {
        const entryBytes = largeSnapshotBytes();
        const budget = cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES;
        const fittingEntries = Math.floor(budget / entryBytes);
        expect(fittingEntries).toBeGreaterThanOrEqual(1);
        expect(fittingEntries).toBeLessThan(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS);

        // Every document stays referenced for the whole test, so nothing here
        // can be released by garbage collection: only the budget can bound it.
        const docs = Array.from({ length: fittingEntries + 2 }, () => createPdfDocumentProxy());
        docs.forEach((doc) => {
            cache.rememberPdfAnnotationSnapshot(null, doc, createLargeSnapshot(doc));
        });

        const survivors = docs.filter(
            doc => cache.readSharedPdfAnnotationSnapshot(null, doc) !== null,
        );
        expect(survivors.length).toBeLessThanOrEqual(fittingEntries);
        expect(survivors.length * entryBytes).toBeLessThanOrEqual(budget);
        expect(cache.readSharedPdfAnnotationSnapshot(null, documentAt(docs, 0))).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(
            null,
            documentAt(docs, docs.length - 1),
        )).not.toBeNull();
    });

    it('counts keyless snapshots against the shared entry ceiling', () => {
        const docs = Array.from({ length: cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS + 1 }, () => createPdfDocumentProxy());
        docs.forEach((doc) => {
            cache.rememberPdfAnnotationSnapshot(
                null,
                doc,
                createSnapshot({
                    doc,
                    commentCount: 4,
                    textLength: 32,
                }),
            );
            expect(cache.readSharedPdfAnnotationSnapshot(null, doc)).not.toBeNull();
        });

        // Small keyless snapshots never approach the byte budget, so without a
        // shared entry ceiling this tier would grow for every open document.
        expect(cache.readSharedPdfAnnotationSnapshot(null, documentAt(docs, 0))).toBeNull();
    });

    it('evicts keyed and keyless tenants against one shared budget', () => {
        const entryBytes = largeSnapshotBytes();
        const fittingEntries = Math.floor(
            cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES / entryBytes,
        );
        expect(fittingEntries).toBeGreaterThanOrEqual(2);

        const keylessDoc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(null, keylessDoc, createLargeSnapshot(keylessDoc));

        const keyedDocs = Array.from({ length: fittingEntries }, () => createPdfDocumentProxy());
        keyedDocs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc,
                createLargeSnapshot(doc),
            );
        });

        // One budget, one recency order: the oldest tenant pays for the newest
        // regardless of which tier each one lives in.
        expect(cache.readSharedPdfAnnotationSnapshot(null, keylessDoc)).toBeNull();
        keyedDocs.forEach((_doc, index) => {
            expect(cache.readSharedPdfAnnotationSnapshot(`revision-${index}`, createPdfDocumentProxy())).not.toBeNull();
        });
    });

    it('hands every reader an isolated payload', () => {
        const doc = createPdfDocumentProxy();
        cache.rememberPdfAnnotationSnapshot(
            'revision-isolated',
            doc,
            createSnapshot({
                doc,
                commentCount: 1,
                textLength: 8,
            }),
        );

        const cached = cache.readSharedPdfAnnotationSnapshot('revision-isolated', createPdfDocumentProxy());
        expect(cached).not.toBeNull();
        const first = cache.cloneSharedPdfAnnotationSnapshot(cached as ISharedPdfAnnotationSnapshot, doc);
        const second = cache.cloneSharedPdfAnnotationSnapshot(cached as ISharedPdfAnnotationSnapshot, doc);
        expect(first.comments).not.toBe(second.comments);
        expect(first.completeness.omissions).not.toBe(second.completeness.omissions);
        expect(first.comments[0]?.annotationId).toBe('annotation-0');
    });

    it('keeps the cached entry isolated from the snapshot it was built from', () => {
        const doc = createPdfDocumentProxy();
        const source = createSnapshot({
            doc,
            commentCount: 1,
            textLength: 8,
        });
        cache.rememberPdfAnnotationSnapshot('revision-source', doc, source);

        source.comments.length = 0;
        source.links.push({
            id: 'link-late',
            pageNumber: 1,
            rect: {
                left: 0,
                top: 0,
                width: 1,
                height: 1,
            },
            url: 'https://example.test/late',
        });

        const cached = cache.readSharedPdfAnnotationSnapshot('revision-source', createPdfDocumentProxy());
        expect(cached?.comments).toHaveLength(1);
        expect(cached?.links).toHaveLength(0);
    });
});

describe('estimateAnnotationSnapshotBytes', () => {
    it('grows with record count and string length', () => {
        const base = estimateAnnotationSnapshotBytes({
            comments: [createComment(0, 10)],
            links: [],
        });
        const moreRecords = estimateAnnotationSnapshotBytes({
            comments: [
                createComment(0, 10),
                createComment(1, 10),
            ],
            links: [],
        });
        const longerText = estimateAnnotationSnapshotBytes({
            comments: [createComment(0, 1_000)],
            links: [],
        });

        expect(moreRecords).toBeGreaterThan(base);
        expect(longerText).toBeGreaterThan(base);
        expect(longerText - base).toBeGreaterThanOrEqual(990 * 2);
    });

    it('prices an empty snapshot as a small constant', () => {
        expect(estimateAnnotationSnapshotBytes({
            comments: [],
            links: [],
        })).toBeLessThan(256);
    });

    it('stops descending a pathologically deep payload instead of overflowing the stack', () => {
        // Acyclic but thousands of levels deep: the cycle guard never fires,
        // so only the depth ceiling keeps the recursion off the stack limit.
        const deep: Record<string, unknown> = {};
        let cursor = deep;
        for (let index = 0; index < 20_000; index += 1) {
            const next: Record<string, unknown> = {};
            cursor.child = next;
            cursor = next;
        }

        expect(estimateAnnotationSnapshotBytes({
            comments: [deep],
            links: [],
        })).toBeLessThan(1_024);
    });

    it('prices a branching cycle once instead of exponentially', () => {
        // A cycle reachable through several properties is re-entered once per
        // property at every level, so a depth guard alone leaves fan-out^depth
        // visits: the total balloons far past the real retained bytes, and a
        // perfectly cacheable snapshot gets rejected as over budget. Six
        // branches over twelve levels is billions of visits without the seen
        // set, so a byte total this small is only reachable by pricing the
        // node once.
        const node: Record<string, unknown> = { text: 'loop' };
        for (let index = 0; index < 5; index += 1) {
            node[`branch-${index}`] = node;
        }

        expect(estimateAnnotationSnapshotBytes({
            comments: [node],
            links: [],
        })).toBeLessThan(1_024);
    });

    it('terminates on a self-referential payload', () => {
        const cyclic: Record<string, unknown> = { name: 'loop' };
        cyclic.self = cyclic;

        expect(estimateAnnotationSnapshotBytes({
            comments: [cyclic],
            links: [],
        })).toBeGreaterThan(0);
    });
});
