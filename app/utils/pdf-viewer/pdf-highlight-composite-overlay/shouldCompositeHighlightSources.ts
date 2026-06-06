import type { THighlightCompositeSource } from '@app/utils/pdf-viewer/pdf-highlight-composite-overlay/highlightCompositeSource';

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

/**
 * True only when at least two sources actually overlap. When highlights are
 * disjoint there is nothing to deconflict, so the overlay is skipped and the
 * native SVGs render as-is — cheaper, and avoids touching the DOM needlessly.
 */
export function shouldCompositeHighlightSources(sources: readonly THighlightCompositeSource[]) {
    for (let i = 0; i < sources.length; i += 1) {
        const source = sources[i];
        if (!source) {
            continue;
        }
        for (let j = i + 1; j < sources.length; j += 1) {
            const candidate = sources[j];
            if (candidate && overlapRect(source, candidate)) {
                return true;
            }
        }
    }
    return false;
}
