import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createPagePreviewDocumentSource } from '@app/utils/document-viewer/source/createPagePreviewDocumentSource';

describe('createPagePreviewDocumentSource', () => {
    it('adapts native preview metrics and leased surfaces to IDocumentPageSource', async () => {
        const revokeObjectURL = vi.fn();
        const source = createPagePreviewDocumentSource({
            documentRef: '/tmp/document.pdf',
            pageSizes: [{
                width: 612,
                height: 792,
            }],
            previewSource: {
                getPageSizes: vi.fn(async () => []),
                renderPageObjectUrl: vi.fn(async () => ({
                    objectUrl: 'blob:page-1',
                    renderedPx: 306,
                })),
                revokeObjectURL,
                terminate: vi.fn(),
            },
        });

        await expect(source.getPageMetrics(1)).resolves.toEqual({
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
        });
        const lease = await source.renderPage({
            pageNumber: 1,
            widthPx: 306,
            priority: 'navigation',
            signal: new AbortController().signal,
        });
        expect(lease.surface).toBe('blob:page-1');
        expect(lease.heightPx).toBe(396);
        lease.release();
        lease.release();
        expect(revokeObjectURL).toHaveBeenCalledOnce();
    });

    it('uses the native page renderer as its thumbnail provider', async () => {
        const renderPageObjectUrl = vi.fn(async () => ({
            objectUrl: 'blob:thumbnail-1',
            renderedPx: 180,
        }));
        const source = createPagePreviewDocumentSource({
            documentRef: '/tmp/document.pdf',
            pageSizes: [{
                width: 500,
                height: 700,
            }],
            previewSource: {
                getPageSizes: vi.fn(async () => []),
                renderPageObjectUrl,
                revokeObjectURL: vi.fn(),
                terminate: vi.fn(),
            },
        });

        const lease = await source.thumbnailProvider!.renderThumbnail({
            pageNumber: 1,
            widthPx: 180,
            priority: 'thumbnail',
            signal: new AbortController().signal,
        });

        expect(renderPageObjectUrl).toHaveBeenCalledWith(1, {targetPx: 180});
        expect(lease.surface).toBe('blob:thumbnail-1');
    });

    it('forwards preview invalidation and detaches it when the surface is released', async () => {
        const invalidationPort: { fire: () => void } = { fire: () => false };
        const detachInvalidation = vi.fn();
        const revokeObjectURL = vi.fn();
        const source = createPagePreviewDocumentSource({
            documentRef: '/tmp/document.pdf',
            pageSizes: [{
                width: 612,
                height: 792,
            }],
            previewSource: {
                getPageSizes: vi.fn(async () => []),
                renderPageObjectUrl: vi.fn(async () => ({
                    objectUrl: 'blob:page-1',
                    renderedPx: 306,
                    onInvalidated(listener: () => void) {
                        invalidationPort.fire = listener;
                        return detachInvalidation;
                    },
                })),
                revokeObjectURL,
                terminate: vi.fn(),
            },
        });
        const lease = await source.renderPage({
            pageNumber: 1,
            widthPx: 306,
            priority: 'navigation',
            signal: new AbortController().signal,
        });
        const onInvalidated = vi.fn();
        lease.onInvalidated?.(onInvalidated);

        invalidationPort.fire();
        invalidationPort.fire();
        expect(onInvalidated).toHaveBeenCalledOnce();

        lease.release();
        expect(detachInvalidation).toHaveBeenCalledOnce();
        expect(revokeObjectURL).toHaveBeenCalledOnce();
    });

    it('promotes an existing preview lease without rendering another surface', async () => {
        const promotePriority = vi.fn();
        const renderPageObjectUrl = vi.fn(async () => ({
            objectUrl: 'blob:page-1',
            renderedPx: 306,
            promotePriority,
        }));
        const source = createPagePreviewDocumentSource({
            documentRef: '/tmp/document.pdf',
            pageSizes: [{
                width: 612,
                height: 792,
            }],
            previewSource: {
                getPageSizes: vi.fn(async () => []),
                renderPageObjectUrl,
                revokeObjectURL: vi.fn(),
                terminate: vi.fn(),
            },
        });

        const lease = await source.renderPage({
            pageNumber: 1,
            widthPx: 306,
            priority: 'nearby',
            signal: new AbortController().signal,
        });
        lease.promotePriority?.('navigation');
        lease.promotePriority?.('visible');

        expect(renderPageObjectUrl).toHaveBeenCalledOnce();
        expect(promotePriority.mock.calls).toEqual([
            [50],
            [100],
        ]);
    });
});
