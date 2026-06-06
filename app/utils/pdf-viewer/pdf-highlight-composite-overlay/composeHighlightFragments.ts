import type { THighlightCompositeSource } from '@app/utils/pdf-viewer/pdf-highlight-composite-overlay/pdfHighlightCompositeOverlayTypes';

/**
 * Per-page compositing overlay for **true text highlights** (PDF `Highlight`
 * subtype). It replaces PDF.js' native per-SVG `mix-blend-mode: multiply`
 * stacking with an explicit z-order model so overlapping highlights stay
 * visually clean. The contract this module exists to guarantee:
 *
 * - **Same-colour overlap** does not stack or darken (no multiply seam — the
 *   artefact Acrobat/Preview/stock PDF.js exhibit and which PDF.js itself
 *   treats as a regression).
 * - **Different-colour overlap** shows the **newest (top-most) annotation's
 *   colour** in the intersection — never a blended third colour.
 *
 * How it works: each contributing highlight SVG is decomposed into axis-aligned
 * rects ({@link extractRectsFromHighlightPath}); the rects are flattened by a
 * painter's algorithm ({@link composeHighlightFragments}) into a single set of
 * non-overlapping fragments; the source SVGs are hidden; and one overlay `<svg>`
 * is rendered. The overlay is multiplied against the page (see
 * `pdfjs-overrides.scss`) so pale colours stay visible on scanned/grayscale pages.
 *
 * Scope: only `highlight` SVGs that are NOT `free` and NOT markup-subtype-draw
 * strokes participate — see {@link shouldCompositeHighlightClassList}. Underline,
 * strikeout and squiggly are strokes, not fills: they are drawn independently
 * and resolve overlap by z-order, so they need no compositing.
 *
 * Refactor warning: the "newest wins, no blending" behaviour is intentional and
 * load-bearing. Do not revert to native multiply stacking without also bringing
 * back the same-colour darkening seam.
 */
interface IHighlightRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface IHighlightPaintFragment extends IHighlightRect {
    fill: string;
    opacity: string;
}

const EPSILON = 0.5;

function overlapRect(left: IHighlightRect, right: IHighlightRect): IHighlightRect | null {
    const x1 = Math.max(left.x, right.x);
    const y1 = Math.max(left.y, right.y);
    const x2 = Math.min(left.x + left.width, right.x + right.width);
    const y2 = Math.min(left.y + left.height, right.y + right.height);
    if (x2 - x1 <= EPSILON || y2 - y1 <= EPSILON) {
        return null;
    }
    return {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
    };
}

function normalizeFragments(rects: IHighlightRect[]) {
    return rects.filter(rect => rect.width > EPSILON && rect.height > EPSILON);
}

/**
 * Subtracts `blocker` from `source`, returning the still-visible parts of
 * `source` as up to four axis-aligned, non-overlapping fragments (top band,
 * bottom band, left-middle, right-middle). Returns `[source]` unchanged when the
 * rects do not overlap. Fragments thinner than {@link EPSILON} are dropped.
 */
function subtractRect(source: IHighlightRect, blocker: IHighlightRect): IHighlightRect[] {
    const overlap = overlapRect(source, blocker);
    if (!overlap) {
        return [source];
    }

    const sourceRight = source.x + source.width;
    const sourceBottom = source.y + source.height;
    const overlapRight = overlap.x + overlap.width;
    const overlapBottom = overlap.y + overlap.height;

    return normalizeFragments([
        {
            x: source.x,
            y: source.y,
            width: source.width,
            height: overlap.y - source.y,
        },
        {
            x: source.x,
            y: overlapBottom,
            width: source.width,
            height: sourceBottom - overlapBottom,
        },
        {
            x: source.x,
            y: overlap.y,
            width: overlap.x - source.x,
            height: overlap.height,
        },
        {
            x: overlapRight,
            y: overlap.y,
            width: sourceRight - overlapRight,
            height: overlap.height,
        },
    ]);
}

function subtractMany(source: IHighlightRect, blockers: IHighlightRect[]) {
    let fragments = [source];
    for (const blocker of blockers) {
        fragments = fragments.flatMap(fragment => subtractRect(fragment, blocker));
        if (fragments.length === 0) {
            break;
        }
    }
    return fragments;
}

/**
 * Flattens overlapping highlight rects into a non-overlapping fragment set using
 * a painter's algorithm.
 *
 * Load-bearing invariant: sources are processed in **reverse order**, so the
 * **last source in DOM order (the newest annotation) wins** — it is emitted in
 * full and every earlier source is subtracted around it. Do not change the
 * iteration order or remove the input `[...sources].reverse()` without
 * intentionally flipping the "newest highlight wins the overlap" contract
 * documented for this module. (The trailing `fragments.reverse()` only restores
 * natural draw order and is cosmetic — fragments never overlap.)
 *
 * Because result fragments never overlap, painting them with any opacity/blend
 * mode cannot double-paint or darken an intersection.
 */
export function composeHighlightFragments(sources: THighlightCompositeSource[]) {
    const occupied: IHighlightRect[] = [];
    const fragments: IHighlightPaintFragment[] = [];

    for (const source of [...sources].reverse()) {
        const visibleFragments = subtractMany(source, occupied);
        visibleFragments.forEach(fragment => fragments.push({
            ...fragment,
            fill: source.fill,
            opacity: source.opacity,
        }));
        occupied.push(source);
    }

    return fragments.reverse();
}
