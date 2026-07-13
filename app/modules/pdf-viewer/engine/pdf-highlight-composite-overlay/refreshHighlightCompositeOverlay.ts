import { composeHighlightFragments } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/composeHighlightFragments';
import { extractRectsFromHighlightPath } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/extractRectsFromHighlightPath';
import { isRectangularHighlightPathData } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/isRectangularHighlightPathData';
import type {
    IHighlightCompositeHost,
    IHighlightPaintFragment,
    IHighlightRect,
    THighlightCompositeSource,
} from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/highlightCompositeSource';
import { shouldCompositeHighlightClassList } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/shouldCompositeHighlightClassList';
import { shouldCompositeHighlightSources } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/shouldCompositeHighlightSources';

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
interface IMeasuredHighlightCompositeSource extends THighlightCompositeSource { svg: SVGElement; }

const OVERLAY_CLASS = 'pdf-highlight-composite-overlay';

const ORIGINAL_HIDDEN_CLASS = 'pdf-highlight-composite-source';

const PRESERVE_SNAPSHOT_CLASS = 'pdf-layer-preserve-snapshot';

const EPSILON = 0.5;

function queryAll<T extends Element>(
    root: ParentNode | null | undefined,
    selector: string,
) {
    return typeof root?.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll<T>(selector))
        : [];
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
    const computedStyle = getComputedStyle(svg);
    const fillAttribute = svg.getAttribute('fill');
    const opacityAttribute = svg.getAttribute('fill-opacity');
    const fill = fillAttribute && fillAttribute.length > 0 ? fillAttribute : computedStyle.fill;
    const opacity = opacityAttribute && opacityAttribute.length > 0
        ? opacityAttribute
        : computedStyle.fillOpacity || '1';
    return {
        fill: fill && fill !== 'none' ? fill : '#ffff66',
        opacity,
    };
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

function isRectangularHighlightSourceSvg(svg: SVGElement) {
    const path = svg.querySelector('path');
    return isRectangularHighlightPathData(path?.getAttribute('d'));
}

function removeCompositeOverlay(host: HTMLElement) {
    if (typeof host.querySelector === 'function') {
        host.querySelector<SVGSVGElement>(
            `:scope > .${OVERLAY_CLASS}:not(.${PRESERVE_SNAPSHOT_CLASS})`,
        )?.remove();
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
        host.querySelector<SVGSVGElement>(
            `:scope > .${OVERLAY_CLASS}:not(.${PRESERVE_SNAPSHOT_CLASS})`,
        )?.remove();
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

function buildCompositePlan(host: HTMLElement) {
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
 * Rebuilds the overlay for one page: computes the composite plan, hides the
 * source highlight SVGs that were folded into it (toggling the
 * `pdf-highlight-composite-source` class), and renders the single overlay
 * element. Removes the overlay entirely when nothing overlaps. Driven reactively
 * by the MutationObserver installed via {@link observeHighlightCompositeOverlay}.
 */
export function refreshHighlightCompositeOverlay(pageContainer: HTMLElement) {
    const host = pageContainer.querySelector<IHighlightCompositeHost>('.page_canvas__render-layer')
        ?? pageContainer.querySelector<IHighlightCompositeHost>('.page_canvas, .canvasWrapper');
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
