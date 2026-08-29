import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';

export type TPageOpsRotationAngle = 90 | 180 | 270;

export interface IPageOpsMetadataSnapshot {
    /** Omitted until the viewer has read the document's page labels. */
    pageLabels?: string[] | null;
    /** Compact page-label source of truth, including when pageLabels is null. */
    pageLabelRanges?: IPdfPageLabelRange[];
    /** Omitted until the viewer has read the document's outline tree. */
    bookmarks?: IPdfBookmarkEntry[];
    untitledBookmarkLabel: string;
}

export interface IPageOpsMutationOptions {
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    metadataSnapshot?: IPageOpsMetadataSnapshot;
}

/** A contiguous page mapping in a structural page operation. */
export interface IPageIdentityRangeMapping {
    kind: 'retain' | 'move';
    /** One-based source page at the start of the range. */
    fromPageNumber: number;
    /** One-based destination page at the start of the range. */
    toPageNumber: number;
    /** Number of pages in the range. */
    count: number;
}

/** A contiguous run of newly inserted pages. */
export interface IPageIdentityRangeInsert {
    kind: 'insert';
    /** One-based destination page at the start of the run. */
    toPageNumber: number;
    count: number;
    /** Seed used to derive one UUID per inserted page without an array. */
    identitySeed: string;
    /** Small legacy-compatible insertions may carry their concrete UUIDs. */
    insertedIds?: string[];
}

/** A contiguous run of source pages removed by a structural operation. */
export interface IPageIdentityRangeDelete {
    kind: 'delete';
    /** One-based source page at the start of the removed run. */
    fromPageNumber: number;
    count: number;
}

/** A contiguous run whose bytes changed but whose page identities did not. */
export interface IPageIdentityRangeTouch {
    kind: 'touch';
    /** One-based destination page at the start of the touched run. */
    toPageNumber: number;
    count: number;
    reason: 'rotate' | 'crop' | 'remove-crop';
}

export type TPageIdentityRangeOperation =
    | IPageIdentityRangeMapping
    | IPageIdentityRangeInsert
    | IPageIdentityRangeDelete
    | IPageIdentityRangeTouch;

export type TPageIdentityDeltaPage = {fromPageNumber: number} | {insertedId: string};

export interface IPageIdentityDelta {
    previousPageCount: number;
    /**
     * The v1 full permutation. New large-document deltas omit this field and
     * use ranges instead. Keeping it optional lets the IPC contract carry a
     * million-page operation without allocating a million objects.
     */
    pages?: TPageIdentityDeltaPage[];
    /** Number of pages after the operation, required when pages is omitted. */
    nextPageCount?: number;
    /** Sparse range mappings and structural edits for large documents. */
    ranges?: TPageIdentityRangeOperation[];
}

/** Returns the page count published by either the v1 or sparse delta form. */
export function getPageIdentityDeltaNextPageCount(delta: IPageIdentityDelta) {
    return delta.nextPageCount ?? delta.pages?.length;
}

/**
 * Maps one-based source page numbers through a page-tree delta. Inserted and
 * deleted pages have no source page and therefore return null. Range deltas
 * intentionally list every surviving range, including unchanged ranges.
 */
export function mapPageNumberThroughPageIdentityDelta(
    delta: IPageIdentityDelta,
    pageNumber: number,
) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        return null;
    }
    if (delta.pages !== undefined) {
        const nextPageIndex = delta.pages.findIndex(page => (
            'fromPageNumber' in page && page.fromPageNumber === pageNumber
        ));
        return nextPageIndex < 0 ? null : nextPageIndex + 1;
    }
    for (const range of delta.ranges ?? []) {
        if (
            (range.kind === 'retain' || range.kind === 'move')
            && pageNumber >= range.fromPageNumber
            && pageNumber < range.fromPageNumber + range.count
        ) {
            return range.toPageNumber + pageNumber - range.fromPageNumber;
        }
    }
    return null;
}

export interface IPageOpsResult {
    success: boolean;
    pageCount?: number;
    documentRevision?: IDocumentRevisionInfo;
    pageIdentityDelta?: IPageIdentityDelta;
}

export interface IPageOpsExtractResult {
    success: boolean;
    canceled?: boolean;
    destPath?: TDocumentRef;
}

export interface IPageOpsInsertResult {
    success: boolean;
    canceled?: boolean;
    documentRevision?: IDocumentRevisionInfo;
    pageIdentityDelta?: IPageIdentityDelta;
}
