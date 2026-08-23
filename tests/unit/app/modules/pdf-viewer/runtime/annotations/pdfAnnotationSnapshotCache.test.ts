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
import { estimateAnnotationSnapshotBytes } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/estimateAnnotationSnapshotBytes';

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
    doc: object;
    commentCount: number;
    textLength: number;
}): IPdfAnnotationSnapshot {
    return {
        doc: options.doc as never,
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

function createLargeSnapshot(doc: object): IPdfAnnotationSnapshot {
    return createSnapshot({
        doc,
        commentCount: LARGE_COMMENT_COUNT,
        textLength: LARGE_TEXT_LENGTH,
    });
}

function largeSnapshotBytes() {
    return estimateAnnotationSnapshotBytes(createLargeSnapshot({}));
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
        const docs = Array.from({ length: cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS }, () => ({}));
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc as never,
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
            const hit = cache.readSharedPdfAnnotationSnapshot(`revision-${index}`, {} as never);
            expect(hit?.comments).toHaveLength(4);
        });
    });

    it('still evicts by count when small entries never approach the byte budget', () => {
        const docs = Array.from({ length: cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS + 1 }, () => ({}));
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc as never,
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
        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', {} as never)).toBeNull();
        for (let index = 1; index < docs.length; index += 1) {
            expect(cache.readSharedPdfAnnotationSnapshot(`revision-${index}`, {} as never)).not.toBeNull();
        }
    });

    it('evicts the oldest entries when the byte budget is exceeded before the count limit', () => {
        const entryBytes = largeSnapshotBytes();
        const budget = cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES;
        const fittingEntries = Math.floor(budget / entryBytes);

        expect(entryBytes).toBeLessThan(budget);
        expect(fittingEntries).toBeGreaterThanOrEqual(1);
        expect(fittingEntries).toBeLessThan(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS);

        const docs = Array.from({ length: fittingEntries + 1 }, () => ({}));
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc as never,
                createLargeSnapshot(doc),
            );
        });

        // The oldest entry is gone even though the entry count never reached
        // the eight-snapshot ceiling.
        const evictedDoc = {};
        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', evictedDoc as never)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(
            `revision-${docs.length - 1}`,
            {} as never,
        )).not.toBeNull();
    });

    it('refreshes recency on a hit so the least recently used entry is evicted first', () => {
        const entryBytes = largeSnapshotBytes();
        const fittingEntries = Math.floor(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES / entryBytes);
        expect(fittingEntries).toBeGreaterThanOrEqual(2);

        const docs = Array.from({ length: fittingEntries }, () => ({}));
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc as never,
                createLargeSnapshot(doc),
            );
        });

        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', {} as never)).not.toBeNull();

        const extraDoc = {};
        cache.rememberPdfAnnotationSnapshot(
            'revision-extra',
            extraDoc as never,
            createLargeSnapshot(extraDoc),
        );

        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', {} as never)).not.toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot('revision-1', {} as never)).toBeNull();
    });

    it('refreshes recency for a proxy-keyed hit too', () => {
        const entryBytes = largeSnapshotBytes();
        const fittingEntries = Math.floor(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES / entryBytes);
        expect(fittingEntries).toBeGreaterThanOrEqual(2);

        const docs = Array.from({ length: fittingEntries }, () => ({}));
        docs.forEach((doc) => {
            cache.rememberPdfAnnotationSnapshot(null, doc as never, createLargeSnapshot(doc));
        });

        expect(cache.readSharedPdfAnnotationSnapshot(null, docs[0] as never)).not.toBeNull();

        const extraDoc = {};
        cache.rememberPdfAnnotationSnapshot(null, extraDoc as never, createLargeSnapshot(extraDoc));

        // Both tiers share one recency order, so a proxy-keyed read has to
        // protect its entry the same way a keyed read does.
        expect(cache.readSharedPdfAnnotationSnapshot(null, docs[0] as never)).not.toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(null, docs[1] as never)).toBeNull();
    });

    it('never retains a single snapshot larger than the whole budget', () => {
        const smallDoc = {};
        cache.rememberPdfAnnotationSnapshot(
            'revision-small',
            smallDoc as never,
            createSnapshot({
                doc: smallDoc,
                commentCount: 2,
                textLength: 16,
            }),
        );

        const hugeDoc = {};
        const huge = createSnapshot({
            doc: hugeDoc,
            commentCount: 200,
            textLength: LARGE_TEXT_LENGTH,
        });
        expect(estimateAnnotationSnapshotBytes(huge))
            .toBeGreaterThan(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES);

        cache.rememberPdfAnnotationSnapshot('revision-huge', hugeDoc as never, huge);

        expect(cache.readSharedPdfAnnotationSnapshot('revision-huge', {} as never)).toBeNull();
        // Rejecting the oversized payload must not cost the existing tenants.
        expect(cache.readSharedPdfAnnotationSnapshot('revision-small', {} as never)).not.toBeNull();
    });

    it('replaces an entry under the same key without leaking its byte accounting', () => {
        const doc = {};
        const fittingEntries = Math.floor(
            cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES / largeSnapshotBytes(),
        );

        for (let attempt = 0; attempt < fittingEntries + 3; attempt += 1) {
            cache.rememberPdfAnnotationSnapshot(
                'revision-stable',
                doc as never,
                createLargeSnapshot(doc),
            );
        }

        expect(cache.readSharedPdfAnnotationSnapshot('revision-stable', {} as never)).not.toBeNull();
    });

    it('frees the whole budget when repeated replacement is the only traffic', () => {
        const doc = {};
        for (let attempt = 0; attempt < 6; attempt += 1) {
            cache.rememberPdfAnnotationSnapshot(
                'revision-stable',
                doc as never,
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

        const docs = Array.from({ length: remainingSlots }, () => ({}));
        docs.forEach((otherDoc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-other-${index}`,
                otherDoc as never,
                createLargeSnapshot(otherDoc),
            );
        });

        expect(cache.readSharedPdfAnnotationSnapshot('revision-stable', {} as never)).not.toBeNull();
        docs.forEach((_doc, index) => {
            expect(cache.readSharedPdfAnnotationSnapshot(`revision-other-${index}`, {} as never))
                .not.toBeNull();
        });
    });

    it('falls back to the document-keyed snapshot when there is no revision key', () => {
        const doc = {};
        cache.rememberPdfAnnotationSnapshot(
            null,
            doc as never,
            createSnapshot({
                doc,
                commentCount: 3,
                textLength: 8,
            }),
        );

        expect(cache.readSharedPdfAnnotationSnapshot(null, doc as never)?.comments).toHaveLength(3);
        expect(cache.readSharedPdfAnnotationSnapshot(null, {} as never)).toBeNull();
    });

    it('treats an empty revision token as no key at all', () => {
        const doc = {};
        cache.rememberPdfAnnotationSnapshot(
            '',
            doc as never,
            createSnapshot({
                doc,
                commentCount: 2,
                textLength: 8,
            }),
        );

        // An empty token identifies no revision, so filing the entry under it
        // would create a key every document without a token collides on.
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc as never)?.comments).toHaveLength(2);
        expect(cache.readSharedPdfAnnotationSnapshot('', doc as never)?.comments).toHaveLength(2);
        expect(cache.readSharedPdfAnnotationSnapshot(null, {} as never)).toBeNull();
    });

    it('treats a keyed miss as a miss instead of serving the proxy fallback', () => {
        const doc = {};
        cache.rememberPdfAnnotationSnapshot(
            'revision-before-edit',
            doc as never,
            createSnapshot({
                doc,
                commentCount: 5,
                textLength: 8,
            }),
        );

        // Same PDF.js proxy, next revision token: the cached payload describes
        // the pre-edit inventory, so the new revision must miss outright.
        expect(cache.readSharedPdfAnnotationSnapshot('revision-after-edit', doc as never)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot('revision-before-edit', doc as never)?.comments)
            .toHaveLength(5);
    });

    it('does not answer a keyed read with a snapshot stored without a key', () => {
        const doc = {};
        cache.rememberPdfAnnotationSnapshot(
            null,
            doc as never,
            createSnapshot({
                doc,
                commentCount: 7,
                textLength: 8,
            }),
        );

        expect(cache.readSharedPdfAnnotationSnapshot('revision-any', doc as never)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc as never)?.comments).toHaveLength(7);
    });

    it('keeps a keyed snapshot out of the proxy tier entirely', () => {
        const doc = {};
        cache.rememberPdfAnnotationSnapshot(
            'revision-keyed-only',
            doc as never,
            createSnapshot({
                doc,
                commentCount: 6,
                textLength: 8,
            }),
        );

        // Mirroring a keyed payload into the proxy tier would keep it alive
        // for as long as the PDF.js proxy lives, outside the entry ceiling and
        // the byte budget that the keyed LRU enforces.
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc as never)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot('revision-keyed-only', doc as never)?.comments)
            .toHaveLength(6);
    });

    it('supersedes a proxy-tier snapshot when the same document is cached under a key', () => {
        const doc = {};
        cache.rememberPdfAnnotationSnapshot(
            null,
            doc as never,
            createSnapshot({
                doc,
                commentCount: 3,
                textLength: 8,
            }),
        );
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc as never)).not.toBeNull();

        cache.rememberPdfAnnotationSnapshot(
            'revision-1',
            doc as never,
            createSnapshot({
                doc,
                commentCount: 9,
                textLength: 8,
            }),
        );

        // The keyless entry describes an inventory this document has already
        // moved past, so a later keyless lookup must not resurrect it.
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc as never)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot('revision-1', doc as never)?.comments)
            .toHaveLength(9);
    });

    it('leaves a count-evicted keyed snapshot unreachable through every lookup', () => {
        const docs = Array.from({ length: cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS + 1 }, () => ({}));
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc as never,
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
        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', docs[0] as never)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(null, docs[0] as never)).toBeNull();
    });

    it('does not answer a keyed read with an evicted entry via the proxy fallback', () => {
        const entryBytes = largeSnapshotBytes();
        const fittingEntries = Math.floor(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES / entryBytes);

        const docs = Array.from({ length: fittingEntries + 1 }, () => ({}));
        docs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc as never,
                createLargeSnapshot(doc),
            );
        });

        // Reading the evicted tenant by key or by proxy must not resurrect
        // what the byte budget just released.
        expect(cache.readSharedPdfAnnotationSnapshot('revision-0', docs[0] as never)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(null, docs[0] as never)).toBeNull();
    });

    it('declines to cache an oversized snapshot stored without a key', () => {
        const doc = {};
        const huge = createSnapshot({
            doc,
            commentCount: 200,
            textLength: LARGE_TEXT_LENGTH,
        });
        expect(estimateAnnotationSnapshotBytes(huge))
            .toBeGreaterThan(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES);

        cache.rememberPdfAnnotationSnapshot(null, doc as never, huge);

        expect(cache.readSharedPdfAnnotationSnapshot(null, doc as never)).toBeNull();
    });

    it('skips the proxy write too when a keyed snapshot is over budget', () => {
        const doc = {};
        const huge = createSnapshot({
            doc,
            commentCount: 200,
            textLength: LARGE_TEXT_LENGTH,
        });

        cache.rememberPdfAnnotationSnapshot('revision-huge', doc as never, huge);

        expect(cache.readSharedPdfAnnotationSnapshot('revision-huge', doc as never)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc as never)).toBeNull();
    });

    it('drops a stale keyless snapshot when its replacement is rejected as oversized', () => {
        const doc = {};
        cache.rememberPdfAnnotationSnapshot(
            null,
            doc as never,
            createSnapshot({
                doc,
                commentCount: 2,
                textLength: 8,
            }),
        );
        expect(cache.readSharedPdfAnnotationSnapshot(null, doc as never)).not.toBeNull();

        cache.rememberPdfAnnotationSnapshot(
            null,
            doc as never,
            createSnapshot({
                doc,
                commentCount: 200,
                textLength: LARGE_TEXT_LENGTH,
            }),
        );

        expect(cache.readSharedPdfAnnotationSnapshot(null, doc as never)).toBeNull();
    });

    it('holds keyless snapshots to the shared byte budget across live documents', () => {
        const entryBytes = largeSnapshotBytes();
        const budget = cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES;
        const fittingEntries = Math.floor(budget / entryBytes);
        expect(fittingEntries).toBeGreaterThanOrEqual(1);
        expect(fittingEntries).toBeLessThan(cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS);

        // Every document stays referenced for the whole test, so nothing here
        // can be released by garbage collection: only the budget can bound it.
        const docs = Array.from({ length: fittingEntries + 2 }, () => ({}));
        docs.forEach((doc) => {
            cache.rememberPdfAnnotationSnapshot(null, doc as never, createLargeSnapshot(doc));
        });

        const survivors = docs.filter(
            doc => cache.readSharedPdfAnnotationSnapshot(null, doc as never) !== null,
        );
        expect(survivors.length).toBeLessThanOrEqual(fittingEntries);
        expect(survivors.length * entryBytes).toBeLessThanOrEqual(budget);
        expect(cache.readSharedPdfAnnotationSnapshot(null, docs[0] as never)).toBeNull();
        expect(cache.readSharedPdfAnnotationSnapshot(
            null,
            docs[docs.length - 1] as never,
        )).not.toBeNull();
    });

    it('counts keyless snapshots against the shared entry ceiling', () => {
        const docs = Array.from({ length: cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS + 1 }, () => ({}));
        docs.forEach((doc) => {
            cache.rememberPdfAnnotationSnapshot(
                null,
                doc as never,
                createSnapshot({
                    doc,
                    commentCount: 4,
                    textLength: 32,
                }),
            );
            expect(cache.readSharedPdfAnnotationSnapshot(null, doc as never)).not.toBeNull();
        });

        // Small keyless snapshots never approach the byte budget, so without a
        // shared entry ceiling this tier would grow for every open document.
        expect(cache.readSharedPdfAnnotationSnapshot(null, docs[0] as never)).toBeNull();
    });

    it('evicts keyed and keyless tenants against one shared budget', () => {
        const entryBytes = largeSnapshotBytes();
        const fittingEntries = Math.floor(
            cache.MAX_SHARED_PDF_ANNOTATION_SNAPSHOT_BYTES / entryBytes,
        );
        expect(fittingEntries).toBeGreaterThanOrEqual(2);

        const keylessDoc = {};
        cache.rememberPdfAnnotationSnapshot(null, keylessDoc as never, createLargeSnapshot(keylessDoc));

        const keyedDocs = Array.from({ length: fittingEntries }, () => ({}));
        keyedDocs.forEach((doc, index) => {
            cache.rememberPdfAnnotationSnapshot(
                `revision-${index}`,
                doc as never,
                createLargeSnapshot(doc),
            );
        });

        // One budget, one recency order: the oldest tenant pays for the newest
        // regardless of which tier each one lives in.
        expect(cache.readSharedPdfAnnotationSnapshot(null, keylessDoc as never)).toBeNull();
        keyedDocs.forEach((_doc, index) => {
            expect(cache.readSharedPdfAnnotationSnapshot(`revision-${index}`, {} as never)).not.toBeNull();
        });
    });

    it('hands every reader an isolated payload', () => {
        const doc = {};
        cache.rememberPdfAnnotationSnapshot(
            'revision-isolated',
            doc as never,
            createSnapshot({
                doc,
                commentCount: 1,
                textLength: 8,
            }),
        );

        const cached = cache.readSharedPdfAnnotationSnapshot('revision-isolated', {} as never);
        expect(cached).not.toBeNull();
        const first = cache.cloneSharedPdfAnnotationSnapshot(cached as ISharedPdfAnnotationSnapshot, doc as never);
        const second = cache.cloneSharedPdfAnnotationSnapshot(cached as ISharedPdfAnnotationSnapshot, doc as never);
        expect(first.comments).not.toBe(second.comments);
        expect(first.completeness.omissions).not.toBe(second.completeness.omissions);
        expect(first.comments[0]?.annotationId).toBe('annotation-0');
    });

    it('keeps the cached entry isolated from the snapshot it was built from', () => {
        const doc = {};
        const source = createSnapshot({
            doc,
            commentCount: 1,
            textLength: 8,
        });
        cache.rememberPdfAnnotationSnapshot('revision-source', doc as never, source);

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

        const cached = cache.readSharedPdfAnnotationSnapshot('revision-source', {} as never);
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
