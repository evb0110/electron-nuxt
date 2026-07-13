export interface IDocumentZoomPageLayout {
    top: number;
    width: number;
    height: number;
}

export interface IDocumentZoomAnchor {
    pageIndex: number;
    xRatio: number;
    yRatio: number;
}

export function captureDocumentZoomAnchor(
    container: Pick<HTMLElement, 'clientHeight' | 'clientWidth' | 'scrollLeft' | 'scrollTop'>,
    layouts: readonly IDocumentZoomPageLayout[],
): IDocumentZoomAnchor | null {
    if (layouts.length === 0) {
        return null;
    }
    const viewportX = container.scrollLeft + container.clientWidth / 2;
    const viewportY = container.scrollTop + container.clientHeight / 2;
    let pageIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    layouts.forEach((layout, index) => {
        const bottom = layout.top + layout.height;
        const distance = viewportY < layout.top
            ? layout.top - viewportY
            : viewportY > bottom ? viewportY - bottom : 0;
        if (distance < nearestDistance) {
            nearestDistance = distance;
            pageIndex = index;
        }
    });
    const layout = layouts[pageIndex]!;
    const left = Math.max(0, (container.clientWidth - layout.width) / 2);
    return {
        pageIndex,
        xRatio: Math.max(0, Math.min(1, (viewportX - left) / Math.max(1, layout.width))),
        yRatio: Math.max(0, Math.min(1, (viewportY - layout.top) / Math.max(1, layout.height))),
    };
}

export function resolveDocumentZoomAnchorScroll(
    container: Pick<HTMLElement, 'clientHeight' | 'clientWidth' | 'scrollLeft' | 'scrollTop'>,
    layouts: readonly IDocumentZoomPageLayout[],
    anchor: IDocumentZoomAnchor | null,
) {
    if (!anchor) {
        return null;
    }
    const layout = layouts[anchor.pageIndex];
    if (!layout) {
        return null;
    }
    const left = Math.max(0, (container.clientWidth - layout.width) / 2);
    return {
        left: Math.max(0, left + layout.width * anchor.xRatio - container.clientWidth / 2),
        top: Math.max(0, layout.top + layout.height * anchor.yRatio - container.clientHeight / 2),
    };
}

export function resolveRetainedDocumentZoomAnchor(
    container: Pick<HTMLElement,
        'clientHeight' | 'clientWidth' | 'scrollHeight' | 'scrollLeft' | 'scrollTop' | 'scrollWidth'>,
    layouts: readonly IDocumentZoomPageLayout[],
    retainedAnchor: IDocumentZoomAnchor | null,
    tolerance = 1,
) {
    if (retainedAnchor) {
        const projected = resolveDocumentZoomAnchorScroll(container, layouts, retainedAnchor);
        if (projected) {
            const projectedLeft = Math.min(
                projected.left,
                Math.max(0, container.scrollWidth - container.clientWidth),
            );
            const projectedTop = Math.min(
                projected.top,
                Math.max(0, container.scrollHeight - container.clientHeight),
            );
            if (
                Math.abs(projectedLeft - container.scrollLeft) <= tolerance
                && Math.abs(projectedTop - container.scrollTop) <= tolerance
            ) {
                return retainedAnchor;
            }
        }
    }
    return captureDocumentZoomAnchor(container, layouts);
}
