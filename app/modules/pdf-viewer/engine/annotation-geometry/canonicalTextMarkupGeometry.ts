import { clamp } from 'es-toolkit/math';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { normalizeMarkerRectBounds } from '@app/utils/pdfMarkerRect';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import {
    MIN_MARKER_RECT_SIZE,
    toMarkerRectFromPdfRect,
} from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';

/**
 * The one boundary where PDF text-markup geometry becomes canonical.
 *
 * Authored geometry and reopened geometry reach the save verifier from two
 * different worlds. Authored geometry is a list of page-normalized selection
 * boxes the store holds. Reopened geometry is a `/QuadPoints` array read back
 * from the saved file. The two only compare if a single documented mapping owns
 * every representational difference between them:
 *
 * - **Coordinate frame.** Canonical geometry is a page-display marker rect: the
 *   same frame `toMarkerRectFromPdfRect` produces and `toPdfRectFromMarkerRect`
 *   consumes, with the page's `/Rotate` already applied. That is the frame the
 *   overlay, the comment list and every other marker rect in this project use,
 *   so a rotated page needs no special case anywhere else. Both sides of the
 *   comparison therefore cross `toMarkerRectFromPdfRect` with the same page
 *   view box and the same rotation.
 * - **Corner order.** The PDF specification orders a quad's four points
 *   upper-left, upper-right, lower-left, lower-right; PDF.js writes the same
 *   order but many producers do not, and PDF.js's own reader re-sorts them.
 *   {@link toCanonicalTextMarkupRectFromQuad} therefore projects each quad
 *   through its own min/max corners, so any corner order yields one rect.
 * - **Quad order.** Nothing in the format pins the order of quads inside
 *   `/QuadPoints`. {@link matchCanonicalTextMarkupGeometry} compares the two
 *   lists as multisets instead of index by index, so a reordered array is not
 *   a fidelity failure while a moved rect still is.
 * - **Float representation.** A quad round trip loses precision twice: PDF.js
 *   keeps quad points in a `Float32Array`, and its writer emits at most two
 *   decimals of a PDF unit. Canonical coordinates are rounded to
 *   {@link CANONICAL_COORDINATE_STEP} so equal geometry compares equal, and
 *   the residue is bounded by {@link TEXT_MARKUP_COORDINATE_TOLERANCE}.
 * - **Degenerate rects.** A selection fragment can be narrower than the
 *   overlay's minimum marker size, and the marker mapping widens it around its
 *   centre. The canonical rule applies that same widening — the one
 *   `MIN_MARKER_RECT_SIZE` the overlay uses, not a second copy of the number —
 *   idempotently, so a rect that already crossed the marker mapping is
 *   unchanged by crossing it again.
 *
 * The mapping is deliberately *not* a tolerance: it is a normal form, and both
 * sides pass through it. A highlight that actually moved changes its canonical
 * rect and still fails verification.
 */

/** Canonical coordinates are rounded to this many normalized units. */
const CANONICAL_COORDINATE_STEP = 1e-6;

/**
 * Largest per-coordinate difference a faithful text-markup round trip may show,
 * in page-normalized units. PDF.js writes coordinates with `numberToString`,
 * which rounds to two decimals of a PDF unit, and stores quad points as
 * `Float32Array`. On the smallest page this project supports that is well under
 * 1e-4 of the page box (≈0.06 pt on US Letter, roughly a fifteenth of a text
 * pixel at 100% zoom), so the tolerance covers representation loss without
 * covering any movement a reader could see.
 */
export const TEXT_MARKUP_COORDINATE_TOLERANCE = 0.0001;

/**
 * Most quads one text-markup annotation contributes as separate rects.
 *
 * A quad is one highlighted line, and a dense page of text holds a few dozen,
 * so this leaves an order of magnitude of headroom over anything a reader
 * produces. Past it the record is treated as a single bounding rect instead:
 * the pairing below is quadratic in the rect count, and a file is free to
 * declare a `/QuadPoints` array with thousands of entries. Legacy ingest and
 * save verification read a record through the same function, so they cross the
 * ceiling together and still compare like against like — a genuine change in
 * quad count across the ceiling still moves the bounding rect or the count.
 */
const MAX_CANONICAL_TEXT_MARKUP_QUADS = 512;

/** The `/QuadPoints` and `/Rect` entries this boundary reads from one record. */
export interface ICanonicalTextMarkupGeometrySource {
    readonly quadPoints?: ArrayLike<number> | null | undefined;
    readonly rect?: readonly number[] | null | undefined;
}

export interface ICanonicalGeometryMatch {
    readonly countMatches: boolean;
    readonly matched: boolean;
    readonly expectedCount: number;
    readonly reopenedCount: number;
    /** Largest coordinate delta over the matched rects, or over the best available pairing. */
    readonly maxCoordinateDelta: number;
    /** Index into the expected geometry whose closest reopened rect was worst. */
    readonly worstRectIndex: number | null;
}

function roundCanonicalCoordinate(value: number) {
    return Math.round(value / CANONICAL_COORDINATE_STEP) * CANONICAL_COORDINATE_STEP;
}

/**
 * Applies the canonical normal form to one page-display marker rect. The rule
 * is idempotent, so geometry that already passed through it — or through
 * `toMarkerRectFromPdfRect`, which widens degenerate rects the same way — is
 * unchanged by a second pass.
 */
export function toCanonicalTextMarkupRect(
    rect: IAnnotationMarkerRect | null | undefined,
): IAnnotationMarkerRect | null {
    if (!rect || ![
        rect.left,
        rect.top,
        rect.width,
        rect.height,
    ].every(value => typeof value === 'number' && Number.isFinite(value))) {
        return null;
    }
    // Clamp into the page box first, then widen, so a degenerate rect on the
    // far page edge settles instead of oscillating between the two rules.
    const clamped = normalizeMarkerRectBounds({
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
    }, { clampSizeToRemaining: true });
    if (!clamped) {
        return null;
    }
    let {
        left,
        top,
        width,
        height,
    } = clamped;
    if (width < MIN_MARKER_RECT_SIZE) {
        left = clamp(left + width / 2 - MIN_MARKER_RECT_SIZE / 2, 0, 1 - MIN_MARKER_RECT_SIZE);
        width = MIN_MARKER_RECT_SIZE;
    }
    if (height < MIN_MARKER_RECT_SIZE) {
        top = clamp(top + height / 2 - MIN_MARKER_RECT_SIZE / 2, 0, 1 - MIN_MARKER_RECT_SIZE);
        height = MIN_MARKER_RECT_SIZE;
    }
    return {
        left: roundCanonicalCoordinate(left),
        top: roundCanonicalCoordinate(top),
        width: roundCanonicalCoordinate(width),
        height: roundCanonicalCoordinate(height),
    };
}

/** Projects one PDF quad (eight numbers, any corner order) onto a canonical rect. */
function toCanonicalTextMarkupRectFromQuad(
    quad: readonly number[],
    pageView: readonly number[],
    pageRotation: TPageRotation,
) {
    if (quad.length < 8) {
        return null;
    }
    const xs = [
        quad[0]!,
        quad[2]!,
        quad[4]!,
        quad[6]!,
    ];
    const ys = [
        quad[1]!,
        quad[3]!,
        quad[5]!,
        quad[7]!,
    ];
    if ([
        ...xs,
        ...ys,
    ].some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        return null;
    }
    return toCanonicalTextMarkupRect(toMarkerRectFromPdfRect([
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
    ], [...pageView], pageRotation));
}

/**
 * The corners of every quad, collapsed into one enclosing quad.
 *
 * Coordinates are read as complete (x, y) pairs and a pair is dropped whole
 * when either half is missing or non-finite. Filtering the flattened array
 * instead would shift every later coordinate's parity, so one `NaN` would turn
 * the remaining x values into y values and yield a plausible-looking rect that
 * encloses nothing the record describes.
 *
 * The bounds are carried incrementally rather than collected and spread into
 * `Math.min`/`Math.max`. This is the branch a file with an unbounded
 * `/QuadPoints` array takes, and a spread call over one coordinate per corner
 * exhausts the engine's argument limit long before such an array stops being
 * something a reader could open.
 */
function boundingQuadOf(quadPoints: ArrayLike<number>, quadCount: number) {
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    let hasPair = false;
    for (let index = 0; index + 1 < quadCount * 8; index += 2) {
        const x = quadPoints[index];
        const y = quadPoints[index + 1];
        if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
            continue;
        }
        hasPair = true;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.max(top, y);
        bottom = Math.min(bottom, y);
    }
    if (!hasPair) {
        return [];
    }
    return [
        left,
        top,
        right,
        top,
        left,
        bottom,
        right,
        bottom,
    ];
}

/**
 * Reads one text-markup record's stored geometry into canonical rects: one rect
 * per `/QuadPoints` quad, or the `/Rect` bounding box when the record carries no
 * usable quads, or their single enclosing rect once there are more quads than
 * {@link MAX_CANONICAL_TEXT_MARKUP_QUADS}. Trailing values that do not complete
 * a quad, and quads that cannot be projected, are dropped; the resulting count
 * difference is reported by the verifier rather than hidden.
 *
 * Legacy ingest and save verification both read a record through this function,
 * so a multi-quad highlight is the same list of rects whether it arrives from
 * the opened document or from the reopened staged bytes.
 */
export function toCanonicalTextMarkupGeometryFromRecord(
    record: ICanonicalTextMarkupGeometrySource,
    pageView: readonly number[] | null | undefined,
    pageRotation: TPageRotation,
): IAnnotationMarkerRect[] {
    if (!pageView || pageView.length < 4) {
        return [];
    }
    const geometry: IAnnotationMarkerRect[] = [];
    const quadPoints = record.quadPoints;
    if (quadPoints && quadPoints.length >= 8) {
        const quadCount = Math.floor(quadPoints.length / 8);
        if (quadCount > MAX_CANONICAL_TEXT_MARKUP_QUADS) {
            const bounding = toCanonicalTextMarkupRectFromQuad(
                boundingQuadOf(quadPoints, quadCount),
                pageView,
                pageRotation,
            );
            return bounding ? [bounding] : [];
        }
        for (let index = 0; index + 7 < quadPoints.length; index += 8) {
            const quad = Array.from({ length: 8 }, (_unused, offset) => quadPoints[index + offset]!);
            const rect = toCanonicalTextMarkupRectFromQuad(quad, pageView, pageRotation);
            if (rect) {
                geometry.push(rect);
            }
        }
    }
    if (geometry.length) {
        return geometry;
    }
    const rect = record.rect && record.rect.length >= 4
        ? toCanonicalTextMarkupRect(toMarkerRectFromPdfRect([...record.rect], [...pageView], pageRotation))
        : null;
    return rect ? [rect] : [];
}

/** Applies the canonical normal form to authored marker geometry. */
export function toCanonicalTextMarkupGeometry(geometry: readonly IAnnotationMarkerRect[]) {
    return geometry.flatMap((rect) => {
        const canonical = toCanonicalTextMarkupRect(rect);
        return canonical ? [canonical] : [];
    });
}

function coordinateDelta(left: IAnnotationMarkerRect, right: IAnnotationMarkerRect) {
    return Math.max(
        Math.abs(left.left - right.left),
        Math.abs(left.top - right.top),
        Math.abs(left.width - right.width),
        Math.abs(left.height - right.height),
    );
}

/**
 * Pairs authored geometry with reopened geometry as multisets. Each expected
 * rect claims its closest unclaimed reopened rect, so quad reordering is not a
 * fidelity failure, and the worst pairing distance is reported either way.
 */
export function matchCanonicalTextMarkupGeometry(
    expected: readonly IAnnotationMarkerRect[],
    reopened: readonly IAnnotationMarkerRect[],
    tolerance = TEXT_MARKUP_COORDINATE_TOLERANCE,
): ICanonicalGeometryMatch {
    const claimed = new Set<number>();
    let maxCoordinateDelta = 0;
    let worstRectIndex: number | null = null;
    let matched = true;
    expected.forEach((expectedRect, expectedIndex) => {
        let bestIndex: number | null = null;
        let bestDelta = Number.POSITIVE_INFINITY;
        reopened.forEach((reopenedRect, reopenedIndex) => {
            if (claimed.has(reopenedIndex)) {
                return;
            }
            const delta = coordinateDelta(expectedRect, reopenedRect);
            if (delta < bestDelta) {
                bestDelta = delta;
                bestIndex = reopenedIndex;
            }
        });
        if (bestIndex === null) {
            matched = false;
            return;
        }
        claimed.add(bestIndex);
        if (bestDelta > tolerance) {
            matched = false;
        }
        if (bestDelta > maxCoordinateDelta) {
            maxCoordinateDelta = bestDelta;
            worstRectIndex = expectedIndex;
        }
    });
    const countMatches = expected.length === reopened.length;
    return {
        countMatches,
        matched: matched && countMatches,
        expectedCount: expected.length,
        reopenedCount: reopened.length,
        maxCoordinateDelta,
        worstRectIndex,
    };
}
