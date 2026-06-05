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

export type THighlightCompositeSource = IHighlightPaintFragment;

interface IMeasuredHighlightCompositeSource extends THighlightCompositeSource { svg: SVGElement; }

interface IHighlightCompositePlan {
    fragments: IHighlightPaintFragment[];
    sourceSvgs: Set<SVGElement>;
}

const OVERLAY_CLASS = 'pdf-highlight-composite-overlay';
const ORIGINAL_HIDDEN_CLASS = 'pdf-highlight-composite-source';
const PRESERVE_SNAPSHOT_CLASS = 'pdf-layer-preserve-snapshot';
const MARKUP_SUBTYPE_DRAW_CLASS_PREFIX = 'pdf-markup-subtype-draw-';
const OBSERVER_KEY = '__evbHighlightCompositeObserver';
const SCHEDULED_KEY = '__evbHighlightCompositeScheduled';
const EPSILON = 0.5;

type THighlightCompositeHost = HTMLElement & {
    [OBSERVER_KEY]?: MutationObserver | undefined;
    [SCHEDULED_KEY]?: boolean | undefined;
};

function queryAll<T extends Element>(
    root: ParentNode | null | undefined,
    selector: string,
) {
    return typeof root?.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll<T>(selector))
        : [];
}

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

function rectFromSvg(hostRect: DOMRect, svg: SVGElement): IHighlightRect | null {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= EPSILON || rect.height <= EPSILON) {
        return null;
    }
    return {
        x: rect.left - hostRect.left,
        y: rect.top - hostRect.top,
        width: rect.width,
        height: rect.height,
    };
}

function subRectsFromSvg(hostRect: DOMRect, svg: SVGElement): IHighlightRect[] | null {
    const path = svg.querySelector('path');
    const normalizedRects = extractRectsFromHighlightPath(path?.getAttribute('d'));
    if (!normalizedRects || normalizedRects.length === 0) {
        return null;
    }
    const svgRect = svg.getBoundingClientRect();
    if (svgRect.width <= EPSILON || svgRect.height <= EPSILON) {
        return null;
    }
    const baseX = svgRect.left - hostRect.left;
    const baseY = svgRect.top - hostRect.top;
    const projected = normalizedRects.map(normalized => ({
        x: baseX + normalized.x * svgRect.width,
        y: baseY + normalized.y * svgRect.height,
        width: normalized.width * svgRect.width,
        height: normalized.height * svgRect.height,
    })).filter(rect => rect.width > EPSILON && rect.height > EPSILON);
    return projected.length > 0 ? projected : null;
}

function getSvgPaint(svg: SVGElement) {
    const fill = svg.getAttribute('fill') || getComputedStyle(svg).fill;
    const opacity = svg.getAttribute('fill-opacity') || getComputedStyle(svg).fillOpacity || '1';
    return {
        fill: fill && fill !== 'none' ? fill : '#ffff66',
        opacity,
    };
}

/**
 * Gate deciding which highlight SVGs participate in compositing. Only genuine
 * text `Highlight` fills qualify. Excluded:
 * - `free` — free-form (drawn) highlights, not text markup.
 * - `pdf-layer-preserve-snapshot` — frozen layer snapshots kept for paint
 *   stability; compositing them would double-draw.
 * - `pdf-markup-subtype-draw-*` — underline/strikeout/squiggly strokes, which
 *   are not fills and resolve overlap by z-order without compositing.
 */
export function shouldCompositeHighlightClassList(classNames: readonly string[]) {
    return classNames.includes('highlight')
        && !classNames.includes('free')
        && !classNames.includes(PRESERVE_SNAPSHOT_CLASS)
        && !classNames.some(className => className.startsWith(MARKUP_SUBTYPE_DRAW_CLASS_PREFIX));
}

function shouldCompositeHighlightSvg(svg: SVGElement) {
    return shouldCompositeHighlightClassList(Array.from(svg.classList))
        && !svg.classList.contains(OVERLAY_CLASS)
        && isVisibleHighlightSvg(svg)
        && isRectangularHighlightSourceSvg(svg);
}

function isVisibleHighlightSvg(svg: SVGElement) {
    const style = window.getComputedStyle(svg);
    const hiddenByCompositeOverlay = svg.classList.contains(ORIGINAL_HIDDEN_CLASS);
    return style.display !== 'none'
        && (hiddenByCompositeOverlay || style.visibility !== 'hidden')
        && Number(style.opacity || '1') > 0;
}

const HIGHLIGHT_PATH_TOKEN_PATTERN = /[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
const HIGHLIGHT_PATH_CORNER_EPSILON = 1e-6;

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

    const consumeNumber = (): number | null => {
        const token = tokens[cursor];
        if (token === undefined) {
            return null;
        }
        cursor += 1;
        const value = parseFloat(token);
        return Number.isFinite(value) ? value : null;
    };

    const finishSubpath = (): boolean => {
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

export function isRectangularHighlightPathData(pathData: string | null | undefined) {
    return extractRectsFromHighlightPath(pathData) !== null;
}

function isRectangularHighlightSourceSvg(svg: SVGElement) {
    const path = svg.querySelector('path');
    return isRectangularHighlightPathData(path?.getAttribute('d'));
}

function removeCompositeOverlay(host: HTMLElement) {
    if (typeof host.querySelector === 'function') {
        host.querySelector<SVGSVGElement>(`:scope > .${OVERLAY_CLASS}`)?.remove();
    }
    queryAll<SVGElement>(
        host,
        `:scope > svg.${ORIGINAL_HIDDEN_CLASS}:not(.${PRESERVE_SNAPSHOT_CLASS})`,
    ).forEach((svg) => {
        svg.classList.remove(ORIGINAL_HIDDEN_CLASS);
    });
}

function renderCompositeOverlay(host: HTMLElement, fragments: IHighlightPaintFragment[]) {
    if (typeof host.querySelector === 'function') {
        host.querySelector<SVGSVGElement>(`:scope > .${OVERLAY_CLASS}`)?.remove();
    }
    if (fragments.length === 0) {
        return;
    }

    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.classList.add(OVERLAY_CLASS);
    overlay.setAttribute('aria-hidden', 'true');

    for (const fragment of fragments) {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', fragment.x.toFixed(2));
        rect.setAttribute('y', fragment.y.toFixed(2));
        rect.setAttribute('width', fragment.width.toFixed(2));
        rect.setAttribute('height', fragment.height.toFixed(2));
        rect.setAttribute('fill', fragment.fill);
        rect.setAttribute('fill-opacity', fragment.opacity);
        overlay.append(rect);
    }

    host.append(overlay);
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

function buildCompositePlan(host: HTMLElement): IHighlightCompositePlan {
    const highlightSvgs = queryAll<SVGElement>(
        host,
        `:scope > svg.highlight:not(.free):not(.${PRESERVE_SNAPSHOT_CLASS})`,
    ).filter(shouldCompositeHighlightSvg);

    if (highlightSvgs.length === 0) {
        return {
            fragments: [],
            sourceSvgs: new Set<SVGElement>(),
        };
    }

    const hostRect = host.getBoundingClientRect();
    const sources: IMeasuredHighlightCompositeSource[] = [];

    for (const svg of highlightSvgs) {
        const paint = getSvgPaint(svg);
        const subRects = subRectsFromSvg(hostRect, svg);
        if (subRects && subRects.length > 0) {
            for (const rect of subRects) {
                sources.push({
                    ...rect,
                    ...paint,
                    svg,
                });
            }
            continue;
        }
        const rect = rectFromSvg(hostRect, svg);
        if (!rect) {
            continue;
        }
        sources.push({
            ...rect,
            ...paint,
            svg,
        });
    }

    if (!shouldCompositeHighlightSources(sources)) {
        return {
            fragments: [],
            sourceSvgs: new Set<SVGElement>(),
        };
    }

    return {
        fragments: composeHighlightFragments(sources),
        sourceSvgs: new Set(sources.map(source => source.svg)),
    };
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

/**
 * Rebuilds the overlay for one page: computes the composite plan, hides the
 * source highlight SVGs that were folded into it (toggling the
 * `pdf-highlight-composite-source` class), and renders the single overlay
 * element. Removes the overlay entirely when nothing overlaps. Driven reactively
 * by the MutationObserver installed via {@link observeHighlightCompositeOverlay}.
 */
export function refreshHighlightCompositeOverlay(pageContainer: HTMLElement) {
    const host = pageContainer.querySelector<THighlightCompositeHost>('.page_canvas, .canvasWrapper');
    if (!host) {
        return;
    }

    const plan = buildCompositePlan(host);
    const {
        fragments,
        sourceSvgs,
    } = plan;
    if (fragments.length === 0) {
        removeCompositeOverlay(host);
        return;
    }

    queryAll<SVGElement>(
        host,
        `:scope > svg.highlight:not(.free):not(.${PRESERVE_SNAPSHOT_CLASS})`,
    ).forEach((svg) => {
        svg.classList.toggle(ORIGINAL_HIDDEN_CLASS, sourceSvgs.has(svg));
    });
    renderCompositeOverlay(host, fragments);
}

function scheduleCompositeRefresh(host: THighlightCompositeHost) {
    if (host[SCHEDULED_KEY]) {
        return;
    }
    host[SCHEDULED_KEY] = true;
    window.requestAnimationFrame(() => {
        host[SCHEDULED_KEY] = false;
        const pageContainer = host.closest<HTMLElement>('.page_container');
        if (pageContainer) {
            refreshHighlightCompositeOverlay(pageContainer);
        }
    });
}

export function observeHighlightCompositeOverlay(pageContainer: HTMLElement) {
    const host = pageContainer.querySelector<THighlightCompositeHost>('.page_canvas, .canvasWrapper');
    if (!host || host[OBSERVER_KEY] || typeof MutationObserver === 'undefined') {
        return;
    }

    const observer = new MutationObserver((mutations) => {
        const hasHighlightChange = mutations.some((mutation) => {
            const target = mutation.target;
            if (target instanceof SVGElement && target.closest(`.${OVERLAY_CLASS}`)) {
                return false;
            }
            return Array.from(mutation.addedNodes).some(node => (
                node instanceof SVGElement
                && node.classList.contains('highlight')
                && !node.classList.contains(PRESERVE_SNAPSHOT_CLASS)
            ))
                || Array.from(mutation.removedNodes).some(node => (
                    node instanceof SVGElement
                    && node.classList.contains('highlight')
                    && !node.classList.contains(PRESERVE_SNAPSHOT_CLASS)
                ))
                || (
                    target instanceof SVGElement
                    && target.classList.contains('highlight')
                    && !target.classList.contains(PRESERVE_SNAPSHOT_CLASS)
                );
        });
        if (hasHighlightChange) {
            scheduleCompositeRefresh(host);
        }
    });
    observer.observe(host, {
        childList: true,
        attributes: true,
        attributeFilter: [
            'class',
            'style',
            'fill',
            'fill-opacity',
        ],
        subtree: true,
    });
    host[OBSERVER_KEY] = observer;
}

export function disconnectHighlightCompositeOverlay(pageContainer: HTMLElement) {
    const host = pageContainer.querySelector<THighlightCompositeHost>('.page_canvas, .canvasWrapper');
    host?.[OBSERVER_KEY]?.disconnect();
    if (host) {
        host[OBSERVER_KEY] = undefined;
        host[SCHEDULED_KEY] = undefined;
        removeCompositeOverlay(host);
    }
}
