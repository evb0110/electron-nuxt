const placeholderSizeCache = new WeakMap<HTMLElement, {
    width: number;
    height: number;
}>();

export function getPageContainer(containerRoot: HTMLElement, pageIndex: number) {
    if (pageIndex < 0) {
        return null;
    }

    const pageNumber = pageIndex + 1;
    const directMatch = containerRoot.querySelector<HTMLElement>(
        `.page_container[data-page="${pageNumber}"]`,
    );
    if (directMatch) {
        return directMatch;
    }

    const mountedPages = containerRoot.querySelectorAll<HTMLElement>('.page_container');
    for (const pageContainer of mountedPages) {
        const mountedPageNumber = Number.parseInt(pageContainer.dataset.page ?? '', 10);
        if (mountedPageNumber === pageNumber) {
            return pageContainer;
        }
    }

    return null;
}

export function setupPagePlaceholderSizes(
    containerRoot: HTMLElement,
    baseWidth: number,
    baseHeight: number,
    scale: number,
) {
    const width = baseWidth * scale;
    const height = baseHeight * scale;

    const containers = containerRoot.querySelectorAll<HTMLDivElement>('.page_container');
    containers.forEach((container) => {
        const cached = placeholderSizeCache.get(container);
        if (
            cached
            && Math.abs(cached.width - width) < 0.25
            && Math.abs(cached.height - height) < 0.25
        ) {
            return;
        }
        container.style.width = `${width}px`;
        container.style.height = `${height}px`;
        placeholderSizeCache.set(container, {
            width,
            height,
        });
    });
}

export function computeVisibleRange(
    visibleStart: number,
    visibleEnd: number,
    numPages: number,
    buffer: number,
) {
    return {
        renderStart: Math.max(1, visibleStart - buffer),
        renderEnd: Math.min(numPages, visibleEnd + buffer),
    };
}

export interface IPageRange {
    start: number;
    end: number;
}
