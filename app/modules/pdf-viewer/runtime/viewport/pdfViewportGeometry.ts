import { clamp } from 'es-toolkit/math';
import type { TPdfViewMode } from '@contracts/shared';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import {
    getLayoutContentHeight,
    getLayoutPageHeight,
    getLayoutPageTop,
    getLayoutPageWidth,
    getLayoutRowHeight,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

export interface IPdfSemanticAnchor {
    page: number;
    pageXFraction: number;
    pageYFraction: number;
    viewportXFraction: number;
    viewportYFraction: number;
    affinity: 'start' | 'center' | 'end';
}

export interface IPdfViewportPageMetric {
    width: number;
    height: number;
}
export interface IPdfViewportRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * Adapts the immutable layout sensor snapshot to the geometry consumed by the
 * viewport authority.  Navigation decisions must not consult live DOM layout.
 */
export function createPdfViewportGeometryFromLayout(
    metrics: IPdfPageLayoutMetrics,
    viewport: {
        width: number;
        height: number
    },
    revision: number,
): IPdfViewportGeometry {
    const pageRects = metrics.base.pageWidths.map((_width, index) => {
        const rowIndex = metrics.base.pageRowIndices[index] ?? 0;
        const rowStartPage = metrics.base.rowStartPages[rowIndex] ?? index + 1;
        const rowEndPage = metrics.base.rowEndPages[rowIndex] ?? index + 1;
        let rowWidth = 0;
        for (let page = rowStartPage; page <= rowEndPage; page += 1) {
            rowWidth += getLayoutPageWidth(metrics, page - 1);
        }
        rowWidth += Math.max(0, rowEndPage - rowStartPage) * metrics.gap;
        let left = Math.max(0, (viewport.width - rowWidth) / 2);
        for (let page = rowStartPage; page < index + 1; page += 1) {
            left += getLayoutPageWidth(metrics, page - 1) + metrics.gap;
        }
        return {
            left,
            top: getLayoutPageTop(metrics, index) ?? 0,
            width: getLayoutPageWidth(metrics, index),
            height: getLayoutPageHeight(metrics, index),
        };
    });
    const rows = metrics.base.rowStartPages.map((startPage, rowIndex) => {
        const endPage = metrics.base.rowEndPages[rowIndex] ?? startPage;
        const first = pageRects[startPage - 1] ?? {
            left: 0,
            top: 0,
            width: 0,
            height: 0,
        };
        const last = pageRects[endPage - 1] ?? first;
        return {
            startPage,
            endPage,
            rect: {
                left: first.left,
                top: first.top,
                width: last.left + last.width - first.left,
                height: getLayoutRowHeight(metrics, rowIndex) || first.height,
            },
        };
    });
    return {
        revision,
        insetTop: metrics.paddingTop,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        contentWidth: Math.max(viewport.width, ...pageRects.map(rect => rect.left + rect.width)),
        contentHeight: Math.max(viewport.height, getLayoutContentHeight(metrics)),
        pageRects,
        rows,
    };
}

export interface IPdfViewportGeometry {
    revision: number;
    insetTop: number;
    viewportWidth: number;
    viewportHeight: number;
    contentWidth: number;
    contentHeight: number;
    pageRects: readonly IPdfViewportRect[];
    rows: ReadonlyArray<{
        startPage: number;
        endPage: number;
        rect: IPdfViewportRect
    }>;
}

export interface IComputePdfViewportGeometryOptions {
    revision: number;
    pages: readonly IPdfViewportPageMetric[];
    viewportWidth: number;
    viewportHeight: number;
    zoom: number;
    viewMode: TPdfViewMode;
    gap: number;
    padding: number;
}

function getRowEnd(startIndex: number, total: number, mode: TPdfViewMode) {
    if (mode === 'single' || total <= 1) {
        return startIndex;
    }
    if (mode === 'facing-first-single' && startIndex === 0) {
        return 0;
    }
    return Math.min(total - 1, startIndex + 1);
}

export function computePdfViewportGeometry(
    options: IComputePdfViewportGeometryOptions,
): IPdfViewportGeometry {
    const scale = Math.max(0.01, options.zoom);
    const gap = Math.max(0, options.gap);
    const padding = Math.max(0, options.padding);
    const pageRects: IPdfViewportRect[] = [];
    const rows: Array<IPdfViewportGeometry['rows'][number]> = [];
    let top = padding;
    let contentWidth = options.viewportWidth;

    for (let start = 0; start < options.pages.length;) {
        const end = getRowEnd(start, options.pages.length, options.viewMode);
        const rowPages = options.pages.slice(start, end + 1);
        const widths = rowPages.map(page => Math.max(0, page.width * scale));
        const heights = rowPages.map(page => Math.max(0, page.height * scale));
        const rowWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
        const rowHeight = Math.max(0, ...heights);
        let left = Math.max(padding, (options.viewportWidth - rowWidth) / 2);
        for (let offset = 0; offset < rowPages.length; offset += 1) {
            pageRects[start + offset] = {
                left,
                top,
                width: widths[offset]!,
                height: heights[offset]!,
            };
            left += widths[offset]! + gap;
        }
        rows.push({
            startPage: start + 1,
            endPage: end + 1,
            rect: {
                left: Math.max(padding, (options.viewportWidth - rowWidth) / 2),
                top,
                width: rowWidth,
                height: rowHeight,
            },
        });
        contentWidth = Math.max(contentWidth, rowWidth + padding * 2);
        top += rowHeight + gap;
        start = end + 1;
    }

    return {
        revision: options.revision,
        insetTop: padding,
        viewportWidth: options.viewportWidth,
        viewportHeight: options.viewportHeight,
        contentWidth,
        contentHeight: Math.max(options.viewportHeight, top - (rows.length ? gap : 0) + padding),
        pageRects,
        rows,
    };
}

export function resolveScrollForAnchor(geometry: IPdfViewportGeometry, anchor: IPdfSemanticAnchor) {
    const rect = geometry.pageRects[clamp(anchor.page, 1, geometry.pageRects.length) - 1];
    if (!rect) {
        return {
            left: 0,
            top: 0,
        };
    }
    return {
        left: clamp(
            rect.left + clamp(anchor.pageXFraction, 0, 1) * rect.width
                - clamp(anchor.viewportXFraction, 0, 1) * geometry.viewportWidth,
            0,
            Math.max(0, geometry.contentWidth - geometry.viewportWidth),
        ),
        top: clamp(
            rect.top + clamp(anchor.pageYFraction, 0, 1) * rect.height
                - clamp(anchor.viewportYFraction, 0, 1) * geometry.viewportHeight
                - (anchor.affinity === 'start' ? geometry.insetTop : 0),
            0,
            Math.max(0, geometry.contentHeight - geometry.viewportHeight),
        ),
    };
}

export function resolveAnchorFromScroll(
    geometry: IPdfViewportGeometry,
    scroll: {
        left: number;
        top: number
    },
    viewportFraction = {
        x: 0.5,
        y: 0.5,
    },
): IPdfSemanticAnchor {
    const x = scroll.left + geometry.viewportWidth * viewportFraction.x;
    const y = scroll.top + geometry.viewportHeight * viewportFraction.y;
    const verticallyIntersecting = geometry.pageRects
        .map((rect, index) => ({
            rect,
            index,
        }))
        .filter(({rect}) => y >= rect.top && y <= rect.top + rect.height);
    const containingPoint = verticallyIntersecting.find(({rect}) => (
        x >= rect.left && x <= rect.left + rect.width
    ));
    let pageIndex = containingPoint?.index ?? verticallyIntersecting.reduce((best, candidate) => {
        if (best === null) {
            return candidate;
        }
        const candidateDistance = Math.abs(candidate.rect.left + candidate.rect.width / 2 - x);
        const bestDistance = Math.abs(best.rect.left + best.rect.width / 2 - x);
        return candidateDistance < bestDistance ? candidate : best;
    }, null as {
        rect: IPdfViewportRect;
        index: number
    } | null)?.index ?? -1;
    if (pageIndex < 0) {
        pageIndex = geometry.pageRects.reduce((best, rect, index) => (
            Math.abs(rect.top + rect.height / 2 - y)
                < Math.abs(geometry.pageRects[best]!.top + geometry.pageRects[best]!.height / 2 - y)
                ? index : best
        ), 0);
    }
    const rect = geometry.pageRects[pageIndex] ?? {
        left: 0,
        top: 0,
        width: 1,
        height: 1,
    };
    return {
        page: pageIndex + 1,
        pageXFraction: clamp((x - rect.left) / Math.max(1, rect.width), 0, 1),
        pageYFraction: clamp((y - rect.top) / Math.max(1, rect.height), 0, 1),
        viewportXFraction: clamp(viewportFraction.x, 0, 1),
        viewportYFraction: clamp(viewportFraction.y, 0, 1),
        affinity: 'center',
    };
}

export function resolveRetainedAnchorFromScroll(
    geometry: IPdfViewportGeometry,
    scroll: {
        left: number;
        top: number;
    },
    committedAnchor: IPdfSemanticAnchor | null,
    tolerance = 1,
) {
    if (committedAnchor) {
        const projected = resolveScrollForAnchor(geometry, committedAnchor);
        if (
            Math.abs(projected.left - scroll.left) <= tolerance
            && Math.abs(projected.top - scroll.top) <= tolerance
        ) {
            return committedAnchor;
        }
    }
    return resolveAnchorFromScroll(geometry, scroll);
}
