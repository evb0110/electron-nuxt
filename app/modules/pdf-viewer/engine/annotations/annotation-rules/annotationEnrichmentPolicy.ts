/**
 * Annotation enrichment is the whole-document pdf-lib pass that reads every
 * annotation's `/NM` name so imported annotations keep a stable identity
 * across saves. It costs a full parse of the source bytes, so it runs only
 * while the document stays under the limits below.
 *
 * The per-page annotation read that produces comment text, colour, timestamps
 * and author is a separate, always-on path. Enrichment being skipped reduces
 * annotation identity detail; it does not remove annotation data.
 */

/**
 * Page ceiling for the enrichment that runs unprompted while a document
 * opens. Past it the parse competes with first paint, so the read waits for a
 * user action that actually needs annotation identity.
 */
export const MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT = 512;

/**
 * Interactive enrichment may inspect more pages than the open path, but it
 * still shares the full-document inventory ceiling. Past this point a click
 * must not start an unbounded pdf-lib pass.
 */
export const MAX_INTERACTIVE_ANNOTATION_ENRICHMENT_PAGE_COUNT = 5_000;

/**
 * `eager` is the pass that runs on open; `interactive` is the on-demand pass
 * the annotations UI and annotation edits request, which is allowed a larger
 * budget because the user is waiting for it on purpose.
 */
export type TAnnotationEnrichmentIntent = 'eager' | 'interactive';

/**
 * Whether the document currently carries a complete annotation read.
 *
 * - `pending`: no completed pass speaks for the document right now, either
 *   because none has finished or because one is running. A running pass
 *   replaces the previous verdict so the panel never reports a read as
 *   declined while that read is under way.
 * - `enriched`: the full annotation read completed.
 * - `skipped`: a pass declined to run, so the document is knowingly
 *   incomplete. Retryability is a separate fact, see `canRetry`.
 * - `failed`: a pass ran and threw.
 *
 * `skipped` and `failed` both mean the user is looking at partial annotation
 * detail and must be told so, whether or not a retry is possible.
 */
export type TAnnotationEnrichmentStatus =
    | 'pending'
    | 'enriched'
    | 'skipped'
    | 'failed';

/**
 * Why a pass declined to run. `unreadable-source` covers both a source that
 * cannot report its size and the open path's requirement for in-memory bytes:
 * in each case the omission is about source access, not document size, so the
 * user must not be told the document is too large.
 */
export type TAnnotationEnrichmentSkipReason =
    | 'over-byte-limit'
    | 'over-page-count'
    | 'unreadable-source';

/**
 * Completeness and retryability are independent. A 600-page document skips the
 * open-path read yet still enriches on demand; a 200 MB document skips both.
 * Collapsing the two would either hide a real omission or offer a retry that
 * can never succeed.
 */
export interface IAnnotationEnrichmentState {
    status: TAnnotationEnrichmentStatus;
    /** Why the document is incomplete; `null` while pending or enriched. */
    reason: TAnnotationEnrichmentSkipReason | null;
    /** An on-demand pass is within limits and worth offering. */
    canRetry: boolean;
}

export const PENDING_ANNOTATION_ENRICHMENT_STATE: IAnnotationEnrichmentState = Object.freeze({
    status: 'pending',
    reason: null,
    canRetry: false,
});

export interface IAnnotationEnrichmentLimits {
    eagerMaxBytes: number;
    interactiveMaxBytes: number;
}

export interface IAnnotationEnrichmentRequest {
    intent: TAnnotationEnrichmentIntent;
    pageCount: number;
    /** Source size in bytes, or `null` when the source cannot report one. */
    sourceByteSize: number | null;
    isBlobSource: boolean;
    limits: IAnnotationEnrichmentLimits;
}

export interface IAnnotationEnrichmentEligibility {
    allowed: boolean;
    reason: TAnnotationEnrichmentSkipReason | null;
}

const ALLOWED_ELIGIBILITY: IAnnotationEnrichmentEligibility = Object.freeze({
    allowed: true,
    reason: null,
});

function denied(reason: TAnnotationEnrichmentSkipReason): IAnnotationEnrichmentEligibility {
    return {
        allowed: false,
        reason,
    };
}

export function resolveAnnotationEnrichmentMaxBytes(
    intent: TAnnotationEnrichmentIntent,
    limits: IAnnotationEnrichmentLimits,
) {
    return intent === 'interactive'
        ? limits.interactiveMaxBytes
        : limits.eagerMaxBytes;
}

/**
 * The byte boundary is inclusive: a source of exactly the limit still
 * enriches. A source that cannot report its size is never enriched, because
 * the cost of the parse is then unknown.
 */
export function evaluateAnnotationEnrichmentEligibility(
    request: IAnnotationEnrichmentRequest,
): IAnnotationEnrichmentEligibility {
    const {
        intent,
        pageCount,
        sourceByteSize,
        isBlobSource,
        limits,
    } = request;

    if (
        sourceByteSize === null
        || !Number.isFinite(sourceByteSize)
        || sourceByteSize < 0
    ) {
        return denied('unreadable-source');
    }
    if (!Number.isInteger(pageCount) || pageCount < 0) {
        return denied('unreadable-source');
    }
    const maxBytes = resolveAnnotationEnrichmentMaxBytes(intent, limits);
    if (!Number.isFinite(maxBytes) || maxBytes < 0 || sourceByteSize > maxBytes) {
        return denied('over-byte-limit');
    }
    if (intent === 'interactive') {
        return pageCount <= MAX_INTERACTIVE_ANNOTATION_ENRICHMENT_PAGE_COUNT
            ? ALLOWED_ELIGIBILITY
            : denied('over-page-count');
    }
    if (pageCount > MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT) {
        return denied('over-page-count');
    }

    // On open, only an in-memory blob can be reparsed without competing with
    // the document's own byte fetch.
    return isBlobSource ? ALLOWED_ELIGIBILITY : denied('unreadable-source');
}

export function isAnnotationEnrichmentWithinLimits(request: IAnnotationEnrichmentRequest) {
    return evaluateAnnotationEnrichmentEligibility(request).allowed;
}

/**
 * Turns a completed read into the state the panel shows.
 *
 * A skipped read is reported as skipped even when an on-demand pass could
 * still succeed: the document is incomplete right now, and the retry is
 * offered alongside that fact rather than in place of it. When the on-demand
 * pass is itself out of reach its reason wins, because that is the durable
 * explanation the user can act on.
 */
export function resolveAnnotationEnrichmentState(
    readResult: 'reconciled' | 'skipped' | 'failed',
    attemptSkipReason: TAnnotationEnrichmentSkipReason | null,
    interactiveEligibility: IAnnotationEnrichmentEligibility,
): IAnnotationEnrichmentState {
    if (readResult === 'reconciled') {
        return {
            status: 'enriched',
            reason: null,
            canRetry: false,
        };
    }
    if (readResult === 'failed') {
        return {
            status: 'failed',
            reason: null,
            canRetry: interactiveEligibility.allowed,
        };
    }
    return {
        status: 'skipped',
        reason: interactiveEligibility.allowed
            ? attemptSkipReason
            : interactiveEligibility.reason ?? attemptSkipReason,
        canRetry: interactiveEligibility.allowed,
    };
}

export function areAnnotationEnrichmentStatesEqual(
    left: IAnnotationEnrichmentState,
    right: IAnnotationEnrichmentState,
) {
    return left.status === right.status
        && left.reason === right.reason
        && left.canRetry === right.canRetry;
}
