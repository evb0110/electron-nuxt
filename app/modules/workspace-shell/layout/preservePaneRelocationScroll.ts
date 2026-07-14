const PANE_RELOCATION_SCROLL_SELECTOR = '[data-preserve-pane-relocation-scroll]';
const PANE_RELOCATION_SCROLL_ITEM_SELECTOR = '[data-pane-relocation-scroll-item]';

export interface IPaneRelocationScrollSnapshot {
    readonly element: HTMLElement;
    readonly anchorElement: HTMLElement | null;
    readonly anchorPageRatio: number;
    readonly anchorViewportOffsetTop: number;
    readonly left: number;
    readonly top: number;
}

function resolveSemanticAnchor(element: HTMLElement) {
    const viewportRect = element.getBoundingClientRect();
    const viewportCenter = viewportRect.top + (viewportRect.height / 2);
    const candidates = Array.from(
        element.querySelectorAll<HTMLElement>(PANE_RELOCATION_SCROLL_ITEM_SELECTOR),
    ).filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top) > 0;
    });
    return candidates.reduce<HTMLElement | null>((nearest, candidate) => {
        if (!nearest) {
            return candidate;
        }
        const candidateRect = candidate.getBoundingClientRect();
        const nearestRect = nearest.getBoundingClientRect();
        const candidateCenter = candidateRect.top + (candidateRect.height / 2);
        const nearestCenter = nearestRect.top + (nearestRect.height / 2);
        return Math.abs(candidateCenter - viewportCenter) < Math.abs(nearestCenter - viewportCenter)
            ? candidate
            : nearest;
    }, null);
}

export function capturePaneRelocationScroll(root: HTMLElement | null) {
    if (!root) {
        return [];
    }
    return Array.from(root.querySelectorAll<HTMLElement>(PANE_RELOCATION_SCROLL_SELECTOR))
        .map((element) => {
            const anchorElement = resolveSemanticAnchor(element);
            const elementRect = element.getBoundingClientRect();
            const anchorRect = anchorElement?.getBoundingClientRect() ?? null;
            const viewportCenter = elementRect.top + (elementRect.height / 2);
            return {
                element,
                anchorElement,
                anchorPageRatio: anchorRect && anchorRect.height > 0
                    ? Math.max(0, Math.min(1, (viewportCenter - anchorRect.top) / anchorRect.height))
                    : 0,
                anchorViewportOffsetTop: elementRect.height / 2,
                left: element.scrollLeft,
                top: element.scrollTop,
            };
        })
        .filter(snapshot => snapshot.left !== 0 || snapshot.top !== 0);
}

export function restorePaneRelocationScroll(
    snapshots: readonly IPaneRelocationScrollSnapshot[],
) {
    let restored = 0;
    for (const snapshot of snapshots) {
        if (!snapshot.element.isConnected) {
            continue;
        }
        snapshot.element.scrollLeft = snapshot.left;
        if (
            snapshot.anchorElement?.isConnected
            && snapshot.element.contains(snapshot.anchorElement)
        ) {
            const anchorRect = snapshot.anchorElement.getBoundingClientRect();
            const currentViewportOffsetTop = anchorRect.top
                + (anchorRect.height * snapshot.anchorPageRatio)
                - snapshot.element.getBoundingClientRect().top;
            snapshot.element.scrollTop += currentViewportOffsetTop
                - snapshot.anchorViewportOffsetTop;
        } else {
            snapshot.element.scrollTop = snapshot.top;
        }
        restored += 1;
    }
    return restored;
}
