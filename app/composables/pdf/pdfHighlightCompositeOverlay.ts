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

const OVERLAY_CLASS = 'pdf-highlight-composite-overlay';
const ORIGINAL_HIDDEN_CLASS = 'pdf-highlight-composite-source';
const MARKUP_SUBTYPE_DRAW_CLASS_PREFIX = 'pdf-markup-subtype-draw-';
const OBSERVER_KEY = '__evbHighlightCompositeObserver';
const SCHEDULED_KEY = '__evbHighlightCompositeScheduled';
const EPSILON = 0.5;

type THighlightCompositeHost = HTMLElement & {
    [OBSERVER_KEY]?: MutationObserver | undefined;
    [SCHEDULED_KEY]?: boolean | undefined;
};

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

function getSvgPaint(svg: SVGElement) {
    const fill = svg.getAttribute('fill') || getComputedStyle(svg).fill;
    const opacity = svg.getAttribute('fill-opacity') || getComputedStyle(svg).fillOpacity || '1';
    return {
        fill: fill && fill !== 'none' ? fill : '#ffff66',
        opacity,
    };
}

export function shouldCompositeHighlightClassList(classNames: readonly string[]) {
    return classNames.includes('highlight')
        && !classNames.includes('free')
        && !classNames.some(className => className.startsWith(MARKUP_SUBTYPE_DRAW_CLASS_PREFIX));
}

function shouldCompositeHighlightSvg(svg: SVGElement) {
    return shouldCompositeHighlightClassList(Array.from(svg.classList))
        && !svg.classList.contains(OVERLAY_CLASS);
}

function removeCompositeOverlay(host: HTMLElement) {
    host.querySelector<SVGSVGElement>(`:scope > .${OVERLAY_CLASS}`)?.remove();
    host.querySelectorAll<SVGElement>(`:scope > svg.${ORIGINAL_HIDDEN_CLASS}`).forEach((svg) => {
        svg.classList.remove(ORIGINAL_HIDDEN_CLASS);
    });
}

function renderCompositeOverlay(host: HTMLElement, fragments: IHighlightPaintFragment[]) {
    host.querySelector<SVGSVGElement>(`:scope > .${OVERLAY_CLASS}`)?.remove();
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

function buildCompositeFragments(host: HTMLElement) {
    const highlightSvgs = Array.from(
        host.querySelectorAll<SVGElement>(':scope > svg.highlight:not(.free)'),
    ).filter(shouldCompositeHighlightSvg);

    if (highlightSvgs.length === 0) {
        return [];
    }

    const hostRect = host.getBoundingClientRect();
    const sources: THighlightCompositeSource[] = [];

    for (const svg of highlightSvgs) {
        const rect = rectFromSvg(hostRect, svg);
        if (!rect) {
            continue;
        }
        const paint = getSvgPaint(svg);
        sources.push({
            ...rect,
            ...paint,
        });
    }

    return composeHighlightFragments(sources);
}

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

export function refreshHighlightCompositeOverlay(pageContainer: HTMLElement) {
    const host = pageContainer.querySelector<THighlightCompositeHost>('.page_canvas, .canvasWrapper');
    if (!host) {
        return;
    }

    const fragments = buildCompositeFragments(host);
    if (fragments.length === 0) {
        removeCompositeOverlay(host);
        return;
    }

    host.querySelectorAll<SVGElement>(':scope > svg.highlight:not(.free)').forEach((svg) => {
        svg.classList.toggle(ORIGINAL_HIDDEN_CLASS, shouldCompositeHighlightSvg(svg));
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
            ))
                || Array.from(mutation.removedNodes).some(node => (
                    node instanceof SVGElement
                    && node.classList.contains('highlight')
                ))
                || (target instanceof SVGElement && target.classList.contains('highlight'));
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
