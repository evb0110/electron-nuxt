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
    }): {release(): void};
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
): Promise<IDocumentPageSource> {
    const pageSizes = await previewSource.getPageSizes() as IDjvuPointPageSize[];
    const scopeId = `djvu-page-source:${++nextDjvuPageSourceId}`;
    const urlLeases = new Map<string, {lease: {release(): void} | null}>();

    const releaseUrl = (objectUrl: string) => {
        urlLeases.get(objectUrl)?.lease?.release();
        urlLeases.delete(objectUrl);
        previewSource.revokeObjectURL(objectUrl);
    };

    const renderSurface = async (request: Parameters<IDocumentPageSource['renderPage']>[0]) => {
        assertDocumentPageNumber(request.pageNumber, pageSizes.length);
        request.signal.throwIfAborted();
        const pageSize = pageSizes[request.pageNumber - 1]!;
        const rendered = await previewSource.renderPageObjectUrl(request.pageNumber, {
            previewPriority: previewPriorityByClass[request.priority],
            targetWidthPx: request.widthPx,
        });
        if (request.signal.aborted) {
            releaseUrl(rendered.objectUrl);
            request.signal.throwIfAborted();
        }
        const heightPx = Math.max(1, Math.round(
            rendered.renderedPx * Math.max(1, pageSize.height) / Math.max(1, pageSize.width),
        ));
        const bytes = rendered.renderedPx * heightPx * 4;
        const leaseEntry: {lease: {release(): void} | null} = {lease: null};
        urlLeases.set(rendered.objectUrl, leaseEntry);
        leaseEntry.lease = surfaceBudget.reserve({
            scopeId,
            category: 'djvu-preview',
            bytes,
            priority: previewPriorityByClass[request.priority],
            evict: () => releaseUrl(rendered.objectUrl),
        });
        if (!urlLeases.has(rendered.objectUrl)) {
            leaseEntry.lease.release();
            throw new Error('DjVu preview evicted under memory pressure');
        }
        let released = false;
        return {
            widthPx: rendered.renderedPx,
            heightPx,
            bytes,
            surface: rendered.objectUrl,
            release() {
                if (!released) {
                    released = true;
                    releaseUrl(rendered.objectUrl);
                }
            },
        } satisfies IDocumentSurfaceLease;
    };

    return {
        kind: 'djvu',
        documentRef,
        pageCount: pageSizes.length,
        annotationProvider: createDocumentAnnotationSidecar(documentRef),
        ...(previewSource.getPageText ? {textProvider: {async getPageText(pageNumber, signal) {
            assertDocumentPageNumber(pageNumber, pageSizes.length);
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
        getPageMetrics(pageNumber, signal) {
            assertDocumentPageNumber(pageNumber, pageSizes.length);
            signal?.throwIfAborted();
            const size = pageSizes[pageNumber - 1]!;
            const dpi = Number.isFinite(size.dpi) && (size.dpi ?? 0) > 0 ? size.dpi! : 300;
            return Promise.resolve({
                widthPoints: size.width * POINTS_PER_INCH / dpi,
                heightPoints: size.height * POINTS_PER_INCH / dpi,
                rotation: 0,
            });
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
