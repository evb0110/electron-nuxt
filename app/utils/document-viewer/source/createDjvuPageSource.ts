import type { TDocumentRef } from '@contracts/documentRef';
import type { IPagePreviewSource } from '@app/utils/document-viewer/pagePreviewSource';
import {
    assertDocumentPageNumber,
    type IDocumentPageSource,
    type IDocumentSurfaceLease,
    type TDocumentRenderPriority,
} from '@app/utils/document-viewer/source/documentPageSource';
import { createDocumentAnnotationSidecar } from '@app/utils/document-viewer/providers/createDocumentAnnotationSidecar';

const POINTS_PER_INCH = 72;
let nextDjvuPageSourceId = 0;

interface IDjvuPointPageSize {
    width: number;
    height: number;
    dpi?: number | undefined;
}

export interface IDjvuSurfaceBudget {
    reserve(options: {
        scopeId: string;
        category: 'djvu-preview';
        bytes: number;
        priority: number;
        evict?: (() => void) | undefined;
    }): {
        promotePriority?(priority: number): void;
        release(): void
    };
    releaseScope(scopeId: string): void;
}

const previewPriorityByClass: Record<TDocumentRenderPriority, number> = {
    navigation: 100,
    visible: 90,
    nearby: 50,
    thumbnail: 20,
    prefetch: 10,
};

export async function createDjvuPageSource(
    documentRef: TDocumentRef,
    previewSource: IPagePreviewSource,
    surfaceBudget: IDjvuSurfaceBudget,
    options: {initialPageNumber?: number} = {},
): Promise<IDocumentPageSource> {
    const requestedInitialPage = Math.max(1, Math.trunc(options.initialPageNumber ?? 1));
    const pageSizes = new Map<number, IDjvuPointPageSize>();
    let pageCount: number;
    if (previewSource.getPageSourceInfo) {
        const sourceInfo = await previewSource.getPageSourceInfo(requestedInitialPage);
        pageCount = sourceInfo.pageCount;
        pageSizes.set(sourceInfo.pageNumber, sourceInfo.pageSize);
    } else {
        const compatibilityPageSizes = await previewSource.getPageSizes() as IDjvuPointPageSize[];
        pageCount = compatibilityPageSizes.length;
        compatibilityPageSizes.forEach((size, index) => pageSizes.set(index + 1, size));
    }
    const getPageSize = async (pageNumber: number) => {
        assertDocumentPageNumber(pageNumber, pageCount);
        const cached = pageSizes.get(pageNumber);
        if (cached) {
            return cached;
        }
        if (previewSource.getPageSize) {
            const size = await previewSource.getPageSize(pageNumber);
            pageSizes.set(pageNumber, size);
            return size;
        }
        const compatibilityPageSizes = await previewSource.getPageSizes() as IDjvuPointPageSize[];
        compatibilityPageSizes.forEach((size, index) => pageSizes.set(index + 1, size));
        const size = pageSizes.get(pageNumber);
        if (!size) {
            throw new RangeError(`Document page ${pageNumber} is outside 1..${pageCount}`);
        }
        return size;
    };
    const scopeId = `djvu-page-source:${++nextDjvuPageSourceId}`;
    const urlLeases = new Map<string, {
        lease: {
            promotePriority?(priority: number): void;
            release(): void
        } | null;
        invalidationListeners: Set<() => void>;
    }>();

    const releaseUrl = (objectUrl: string) => {
        urlLeases.get(objectUrl)?.lease?.release();
        urlLeases.delete(objectUrl);
        previewSource.revokeObjectURL(objectUrl);
    };

    const renderSurface = async (request: Parameters<IDocumentPageSource['renderPage']>[0]) => {
        assertDocumentPageNumber(request.pageNumber, pageCount);
        request.signal.throwIfAborted();
        const pageSizePromise = getPageSize(request.pageNumber);
        const cancelPreview = () => previewSource.cancelPagePreview?.(request.pageNumber);
        request.signal.addEventListener('abort', cancelPreview, {once: true});
        let rendered;
        try {
            [rendered] = await Promise.all([
                previewSource.renderPageObjectUrl(request.pageNumber, {
                    previewPriority: previewPriorityByClass[request.priority],
                    targetWidthPx: request.widthPx,
                }),
                pageSizePromise,
            ]);
        } finally {
            request.signal.removeEventListener('abort', cancelPreview);
        }
        if (request.signal.aborted) {
            releaseUrl(rendered.objectUrl);
            request.signal.throwIfAborted();
        }
        const pageSize = await pageSizePromise;
        const heightPx = Math.max(1, Math.round(
            rendered.renderedPx * Math.max(1, pageSize.height) / Math.max(1, pageSize.width),
        ));
        const bytes = rendered.renderedPx * heightPx * 4;
        const leaseEntry = {
            lease: null as {
                promotePriority?(priority: number): void;
                release(): void
            } | null,
            invalidationListeners: new Set<() => void>(),
        };
        urlLeases.set(rendered.objectUrl, leaseEntry);
        leaseEntry.lease = surfaceBudget.reserve({
            scopeId,
            category: 'djvu-preview',
            bytes,
            priority: previewPriorityByClass[request.priority],
            evict: () => {
                for (const listener of leaseEntry.invalidationListeners) {
                    listener();
                }
                leaseEntry.invalidationListeners.clear();
                releaseUrl(rendered.objectUrl);
            },
        });
        if (!urlLeases.has(rendered.objectUrl)) {
            leaseEntry.lease.release();
            throw new Error('DjVu preview evicted under memory pressure');
        }
        let released = false;
        let priority = previewPriorityByClass[request.priority];
        return {
            widthPx: rendered.renderedPx,
            heightPx,
            bytes,
            surface: rendered.objectUrl,
            onInvalidated(listener: () => void) {
                leaseEntry.invalidationListeners.add(listener);
                return () => leaseEntry.invalidationListeners.delete(listener);
            },
            promotePriority(nextPriority: TDocumentRenderPriority) {
                const promotedPriority = previewPriorityByClass[nextPriority];
                if (!released && promotedPriority > priority) {
                    priority = promotedPriority;
                    leaseEntry.lease?.promotePriority?.(promotedPriority);
                }
            },
            release() {
                if (!released) {
                    released = true;
                    leaseEntry.invalidationListeners.clear();
                    releaseUrl(rendered.objectUrl);
                }
            },
        } satisfies IDocumentSurfaceLease;
    };

    return {
        kind: 'djvu',
        documentRef,
        pageCount,
        annotationProvider: createDocumentAnnotationSidecar(documentRef),
        ...(previewSource.getPageText ? {textProvider: {async getPageText(pageNumber, signal) {
            assertDocumentPageNumber(pageNumber, pageCount);
            signal.throwIfAborted();
            const text = await previewSource.getPageText!(pageNumber);
            signal.throwIfAborted();
            return text;
        }}} : {}),
        ...(previewSource.getOutline ? {outlineProvider: {async getOutline(signal) {
            signal.throwIfAborted();
            const outline = await previewSource.getOutline!();
            signal.throwIfAborted();
            return outline;
        }}} : {}),
        thumbnailProvider: {renderThumbnail: request => renderSurface({
            ...request,
            priority: 'thumbnail',
        })},
        rasterProvider: {renderRaster: renderSurface},
        async getPageMetrics(pageNumber, signal) {
            assertDocumentPageNumber(pageNumber, pageCount);
            signal?.throwIfAborted();
            const size = await getPageSize(pageNumber);
            signal?.throwIfAborted();
            const dpi = Number.isFinite(size.dpi) && (size.dpi ?? 0) > 0 ? size.dpi! : 300;
            return {
                widthPoints: size.width * POINTS_PER_INCH / dpi,
                heightPoints: size.height * POINTS_PER_INCH / dpi,
                rotation: 0,
            };
        },
        renderPage: renderSurface,
        dispose() {
            for (const objectUrl of [...urlLeases.keys()]) {
                releaseUrl(objectUrl);
            }
            surfaceBudget.releaseScope(scopeId);
            previewSource.terminate();
        },
    };
}
