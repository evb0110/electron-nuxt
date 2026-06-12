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
export interface IHighlightRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IHighlightPaintFragment extends IHighlightRect {
    fill: string;
    opacity: string;
}

export type THighlightCompositeSource = IHighlightPaintFragment;

export interface IHighlightCompositeHost extends HTMLElement {
    __evbHighlightCompositeObserver?: MutationObserver | undefined;
    __evbHighlightCompositeScheduled?: boolean | undefined;
}
