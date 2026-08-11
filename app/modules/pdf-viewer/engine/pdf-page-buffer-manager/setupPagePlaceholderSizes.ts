import type { IPdfPageMetric } from '@app/types/pdfUi';
import {
    buildPdfPageScaleStyle,
    createPdfPageScale,
} from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';

const placeholderSizeCache = new WeakMap<HTMLElement, {
    width: number;
    height: number;
}>();

function setStyleProperty(
    style: CSSStyleDeclaration,
    property: string,
    value: string,
) {
    if (typeof style.setProperty === 'function') {
        style.setProperty(property, value);
        return;
    }

    // Some renderer unit tests intentionally use a minimal HTMLElement double.
    // Keep this pure geometry helper compatible with those doubles without
    // weakening the browser path, where CSSStyleDeclaration#setProperty exists.
    Reflect.set(style, property, value);
}

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
        const scaleStyle = buildPdfPageScaleStyle(createPdfPageScale(scale, metric.userUnit));
        Object.entries(scaleStyle).forEach(([
            property,
            value,
        ]) => {
            setStyleProperty(container.style, property, value);
        });
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
