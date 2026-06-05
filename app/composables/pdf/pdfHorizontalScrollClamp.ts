import {
    getPageRowBoundsForViewMode,
    normalizePageMetrics,
    resolveCurrentSpreadBaseWidth,
} from '@app/composables/pdf/pdfPageLayout';
import { clamp } from 'es-toolkit/math';
import type {
    TFitMode,
    IPdfPageMetric,
    TPdfViewMode,
} from '@app/types/pdf';

export interface IPageBoundedHorizontalScrollInput {
    scrollLeft: number;
    viewportWidth: number;
    pageLeft: number;
    pageWidth: number;
    margin: number;
    epsilon?: number;
}

export interface IRenderedSpreadHorizontalBounds {
    left: number;
    width: number;
}

function isFinitePositive(value: number) {
    return Number.isFinite(value) && value > 0;
}

function normalizeNonNegative(value: number) {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clampNumber(value: number, min: number, max: number) {
    return clamp(value, min, max);
}

export function resolvePageBoundedHorizontalScroll(
    input: IPageBoundedHorizontalScrollInput,
) {
    const viewportWidth = input.viewportWidth;
    const pageWidth = input.pageWidth;
    if (!isFinitePositive(viewportWidth) || !isFinitePositive(pageWidth)) {
        return null;
    }

    const pageLeft = normalizeNonNegative(input.pageLeft);
    const margin = normalizeNonNegative(input.margin);
    const epsilon = normalizeNonNegative(input.epsilon ?? 0.5);
    const contentViewportWidth = Math.max(0, viewportWidth - margin * 2);

    if (pageWidth <= contentViewportWidth + epsilon) {
        const centeredScrollLeft = pageLeft - Math.max(0, (viewportWidth - pageWidth) / 2);
        const targetScrollLeft = Math.max(0, centeredScrollLeft);
        return {
            minScrollLeft: targetScrollLeft,
            maxScrollLeft: targetScrollLeft,
            scrollLeft: targetScrollLeft,
            shouldLock: true,
        };
    }

    const pageRight = pageLeft + pageWidth;
    const minScrollLeft = Math.max(0, pageLeft - margin);
    const maxScrollLeft = Math.max(
        minScrollLeft,
        pageRight + margin - viewportWidth,
    );

    return {
        minScrollLeft,
        maxScrollLeft,
        scrollLeft: clampNumber(input.scrollLeft, minScrollLeft, maxScrollLeft),
        shouldLock: false,
    };
}

export function getCurrentSpreadRenderedBoundsFromDom(options: {
    container: HTMLElement;
    pageNumber: number;
    viewMode: 'single' | 'facing' | 'facing-first-single';
    totalPages: number;
}): IRenderedSpreadHorizontalBounds | null {
    const bounds = getPageRowBoundsForViewMode({
        pageNumber: options.pageNumber,
        viewMode: options.viewMode,
        totalPages: options.totalPages,
    });
    const containerRect = options.container.getBoundingClientRect();
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;

    for (let pageNumber = bounds.start; pageNumber <= bounds.end; pageNumber += 1) {
        const pageElement = options.container.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        );
        if (!pageElement) {
            return null;
        }

        const pageRect = pageElement.getBoundingClientRect();
        const pageWidth = pageRect.width || pageElement.offsetWidth || pageElement.clientWidth;
        if (!Number.isFinite(pageWidth) || pageWidth <= 0) {
            return null;
        }

        const pageLeft = Number.isFinite(pageRect.left)
            ? pageRect.left - containerRect.left + options.container.scrollLeft
            : pageElement.offsetLeft;
        if (!Number.isFinite(pageLeft)) {
            return null;
        }

        left = Math.min(left, pageLeft);
        right = Math.max(right, pageLeft + pageWidth);
    }

    const width = right - left;
    return Number.isFinite(width) && width > 0
        ? {
            left: Math.max(0, left),
            width,
        }
        : null;
}

export function getCurrentSpreadRenderedBoundsFromMetrics(options: {
    container: HTMLElement;
    basePageWidth: number | null;
    basePageHeight: number | null;
    numPages: number;
    pageMetrics: IPdfPageMetric[];
    currentPage: number;
    viewMode: TPdfViewMode;
    effectiveScale: number;
    scaledMargin: number;
}): IRenderedSpreadHorizontalBounds | null {
    if (!options.basePageWidth || !options.basePageHeight || options.numPages <= 0) {
        return null;
    }

    const normalizedMetrics = normalizePageMetrics({
        pageMetrics: options.pageMetrics,
        totalPages: options.numPages,
        fallbackWidth: options.basePageWidth,
        fallbackHeight: options.basePageHeight,
    });
    const rowBounds = getPageRowBoundsForViewMode({
        pageNumber: options.currentPage,
        viewMode: options.viewMode,
        totalPages: options.numPages,
    });
    const rowPageCount = Math.max(1, rowBounds.end - rowBounds.start + 1);
    const baseSpreadWidth = resolveCurrentSpreadBaseWidth(
        normalizedMetrics,
        options.viewMode,
        options.numPages,
        options.currentPage,
    );
    if (!baseSpreadWidth) {
        return null;
    }

    const renderedSpreadWidth =
        baseSpreadWidth * options.effectiveScale
        + Math.max(0, rowPageCount - 1) * options.scaledMargin;
    if (!Number.isFinite(renderedSpreadWidth) || renderedSpreadWidth <= 0) {
        return null;
    }

    return {
        left: Math.max(
            options.scaledMargin,
            (options.container.clientWidth - renderedSpreadWidth) / 2,
        ),
        width: renderedSpreadWidth,
    };
}

export function resolveHorizontalScrollClampForActiveSpread(options: {
    container: HTMLElement | null;
    fitMode: TFitMode;
    pageNumber: number;
    viewMode: TPdfViewMode;
    numPages: number;
    basePageWidth: number | null;
    basePageHeight: number | null;
    pageMetrics: IPdfPageMetric[];
    effectiveScale: number;
    scaledMargin: number;
    epsilon: number;
}) {
    if (!options.container || options.fitMode !== 'width') {
        return null;
    }

    const renderedSpreadBounds =
        getCurrentSpreadRenderedBoundsFromDom({
            container: options.container,
            pageNumber: options.pageNumber,
            viewMode: options.viewMode,
            totalPages: options.numPages,
        })
        ?? getCurrentSpreadRenderedBoundsFromMetrics({
            container: options.container,
            basePageWidth: options.basePageWidth,
            basePageHeight: options.basePageHeight,
            numPages: options.numPages,
            pageMetrics: options.pageMetrics,
            currentPage: options.pageNumber,
            viewMode: options.viewMode,
            effectiveScale: options.effectiveScale,
            scaledMargin: options.scaledMargin,
        });
    if (!renderedSpreadBounds) {
        return null;
    }

    return resolvePageBoundedHorizontalScroll({
        scrollLeft: options.container.scrollLeft,
        viewportWidth: options.container.clientWidth,
        pageLeft: renderedSpreadBounds.left,
        pageWidth: renderedSpreadBounds.width,
        margin: options.scaledMargin,
        epsilon: options.epsilon,
    });
}
