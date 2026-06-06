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

const HIGHLIGHT_PATH_TOKEN_PATTERN = /[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

const HIGHLIGHT_PATH_CORNER_EPSILON = 1e-6;

function parseHighlightSubpaths(tokens: string[]): IHighlightRect[] | null {
    const rects: IHighlightRect[] = [];
    let cursor = 0;
    let penX = 0;
    let penY = 0;
    let startX = 0;
    let startY = 0;
    let positions: Array<{
        x: number;
        y: number;
    }> = [];
    let active = false;
    let lastCommand: string | null = null;

    const consumeNumber = () => {
        const token = tokens[cursor];
        if (token === undefined) {
            return null;
        }
        cursor += 1;
        const value = parseFloat(token);
        return Number.isFinite(value) ? value : null;
    };

    const finishSubpath = () => {
        if (!active) {
            return true;
        }
        active = false;
        if (positions.length === 0) {
            return true;
        }
        let xMin = Infinity;
        let xMax = -Infinity;
        let yMin = Infinity;
        let yMax = -Infinity;
        for (const point of positions) {
            if (point.x < xMin) xMin = point.x;
            if (point.x > xMax) xMax = point.x;
            if (point.y < yMin) yMin = point.y;
            if (point.y > yMax) yMax = point.y;
        }
        const snapshot = positions;
        positions = [];
        if (xMax - xMin <= HIGHLIGHT_PATH_CORNER_EPSILON || yMax - yMin <= HIGHLIGHT_PATH_CORNER_EPSILON) {
            return true;
        }
        const tolerance = HIGHLIGHT_PATH_CORNER_EPSILON;
        for (const point of snapshot) {
            const onLeftOrRight = Math.abs(point.x - xMin) < tolerance || Math.abs(point.x - xMax) < tolerance;
            const onTopOrBottom = Math.abs(point.y - yMin) < tolerance || Math.abs(point.y - yMax) < tolerance;
            if (!onLeftOrRight || !onTopOrBottom) {
                return false;
            }
        }
        rects.push({
            x: xMin,
            y: yMin,
            width: xMax - xMin,
            height: yMax - yMin,
        });
        return true;
    };

    while (cursor < tokens.length) {
        let token = tokens[cursor]!;
        const isLetter = /^[a-zA-Z]$/.test(token);
        if (isLetter) {
            cursor += 1;
            lastCommand = token;
        } else if (lastCommand) {
            token = lastCommand === 'M'
                ? 'L'
                : lastCommand === 'm'
                    ? 'l'
                    : lastCommand;
        } else {
            return null;
        }
        const isRelative = token === token.toLowerCase();
        const upper = token.toUpperCase();

        if (upper === 'M') {
            if (!finishSubpath()) {
                return null;
            }
            const nx = consumeNumber();
            const ny = consumeNumber();
            if (nx === null || ny === null) {
                return null;
            }
            penX = isRelative ? penX + nx : nx;
            penY = isRelative ? penY + ny : ny;
            startX = penX;
            startY = penY;
            positions = [{
                x: penX,
                y: penY,
            }];
            active = true;
        } else if (upper === 'L') {
            if (!active) {
                return null;
            }
            const nx = consumeNumber();
            const ny = consumeNumber();
            if (nx === null || ny === null) {
                return null;
            }
            penX = isRelative ? penX + nx : nx;
            penY = isRelative ? penY + ny : ny;
            positions.push({
                x: penX,
                y: penY,
            });
        } else if (upper === 'H') {
            if (!active) {
                return null;
            }
            const nx = consumeNumber();
            if (nx === null) {
                return null;
            }
            penX = isRelative ? penX + nx : nx;
            positions.push({
                x: penX,
                y: penY,
            });
        } else if (upper === 'V') {
            if (!active) {
                return null;
            }
            const ny = consumeNumber();
            if (ny === null) {
                return null;
            }
            penY = isRelative ? penY + ny : ny;
            positions.push({
                x: penX,
                y: penY,
            });
        } else if (upper === 'Z') {
            if (active) {
                penX = startX;
                penY = startY;
                positions.push({
                    x: startX,
                    y: startY,
                });
                if (!finishSubpath()) {
                    return null;
                }
            }
        } else {
            return null;
        }
    }
    if (!finishSubpath()) {
        return null;
    }
    return rects.length > 0 ? rects : null;
}

/**
 * Parses an SVG highlight path's `d` attribute into axis-aligned rectangles.
 *
 * PDF.js packs a multi-line highlight into ONE path with several `M…Z` subpaths;
 * each subpath is returned as its own rect so per-line overlaps can be
 * subtracted independently. Returns `null` for any non-rectangular subpath
 * (curves, diagonals, notched outlines) — the caller then falls back to the SVG
 * bounding box.
 *
 * Refactor warning: multi-`M` support is required. Collapsing it back to a
 * single bounding rect reintroduces the multi-line blending bug where a newer
 * highlight could not cleanly cover an older overlapping one and blended into a
 * third colour instead.
 */
export function extractRectsFromHighlightPath(
    pathData: string | null | undefined,
): IHighlightRect[] | null {
    const normalized = pathData?.trim();
    if (!normalized) {
        return null;
    }
    const tokens = normalized.match(HIGHLIGHT_PATH_TOKEN_PATTERN);
    if (!tokens || tokens.length === 0) {
        return null;
    }
    return parseHighlightSubpaths(tokens);
}
