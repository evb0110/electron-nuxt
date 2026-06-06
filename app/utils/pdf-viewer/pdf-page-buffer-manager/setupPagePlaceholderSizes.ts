import type { IPdfPageMetric } from '@app/types/pdf';

const placeholderSizeCache = new WeakMap<HTMLElement, {
    width: number;
    height: number;
}>();

export function setupPagePlaceholderSizes(
    containerRoot: HTMLElement,
    pageMetrics: IPdfPageMetric[],
    scale: number,
) {
    const containers = containerRoot.querySelectorAll<HTMLDivElement>('.page_container');
    containers.forEach((container) => {
        const pageNumber = Number.parseInt(container.dataset.page ?? '', 10);
        const metric = Number.isFinite(pageNumber)
            ? pageMetrics[pageNumber - 1]
            : null;
        if (!metric) {
            return;
        }

        const width = metric.width * scale;
        const height = metric.height * scale;
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
