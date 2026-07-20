import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO,
    DocumentThumbnailLayout,
} from '@app/utils/document-viewer/thumbnails/documentThumbnailLayout';

describe('DocumentThumbnailLayout', () => {
    it('grows only the measured row chrome and shifts following virtual rows', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 3,
            renderWidth: 100,
            estimatedAspectRatio: 1,
            itemChromeHeight: 30,
            itemGap: 8,
        });
        const previousThirdTop = layout.getPageTop(3);
        const previousTotal = layout.getTotalHeight();

        expect(layout.updatePageChromeHeight(2, 66)).toBe(true);
        expect(layout.getPageHeight(1)).toBe(130);
        expect(layout.getPageHeight(2)).toBe(166);
        expect(layout.getPageTop(3)).toBe(previousThirdTop + 36);
        expect(layout.getTotalHeight()).toBe(previousTotal + 36);

        expect(layout.updatePageChromeHeight(2, null)).toBe(true);
        expect(layout.getPageTop(3)).toBe(previousThirdTop);
    });
    it('virtualizes a large document to a viewport-sized page range', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 100_000,
            renderWidth: 160,
        });
        const range = layout.resolveVirtualRange(2_000_000, 800, 700);

        expect(range.startPage).toBeGreaterThan(1);
        expect(range.endPage - range.startPage).toBeLessThan(20);
        expect(layout.getTotalHeight()).toBeGreaterThan(10_000_000);
    });

    it('uses deterministic placeholders and replaces individual aspects from page metrics', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 4,
            renderWidth: 100,
        });
        const initialPageTwoTop = layout.getPageTop(2);
        const initialPageThreeTop = layout.getPageTop(3);

        expect(layout.getPageAspect(1)).toBe(DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO);
        expect(layout.updatePageAspect(2, 2)).toBe(true);
        expect(layout.getPageTop(2)).toBe(initialPageTwoTop);
        expect(layout.getPageTop(3)).toBeGreaterThan(initialPageThreeTop);
        expect(layout.getPageAspect(1)).toBe(DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO);
        expect(layout.getPageAspect(2)).toBe(2);
    });

    it('seeds unknown placeholders from the document while preserving exact page aspects', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 4,
            renderWidth: 100,
        });
        layout.updatePageAspect(2, 2);

        expect(layout.setEstimatedAspectRatio(1.5)).toBe(true);
        expect(layout.getPageAspect(1)).toBe(1.5);
        expect(layout.getPageAspect(2)).toBe(2);
        expect(layout.getPageAspect(4)).toBe(1.5);
    });

    it('does not leak learned geometry into the next document', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 4,
            renderWidth: 100,
        });
        layout.setEstimatedAspectRatio(2.4);
        layout.updatePageAspect(2, 1.2);

        layout.resetDocument({
            pageCount: 3,
            renderWidth: 100,
        });

        expect(layout.getPageAspect(1)).toBe(DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO);
        expect(layout.getPageAspect(2)).toBe(DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO);
    });

    it('preserves the visible page and intra-page offset across width and aspect changes', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 500,
            renderWidth: 120,
        });
        const originalScrollTop = layout.getPageTop(220) + 42;
        const anchor = layout.captureAnchor(originalScrollTop);

        layout.updatePageAspect(100, 2.4);
        layout.reset({
            pageCount: 500,
            renderWidth: 180,
        });
        const restored = layout.resolveAnchorScrollTop(anchor);

        expect(layout.resolvePageAtOffset(restored)).toBe(220);
        expect(restored - layout.getPageTop(220)).toBe(42);
    });

    it('updates one page in a large document without rebuilding unrelated prefix geometry', () => {
        const layout = new DocumentThumbnailLayout({
            estimatedAspectRatio: 1,
            pageCount: 10_000,
            renderWidth: 100,
        });
        const beforePageTwo = layout.getPageTop(2);
        const beforePageThree = layout.getPageTop(3);
        const beforePageTwoHeight = layout.getPageHeight(2);

        expect(layout.updatePageAspect(2, 2)).toBe(true);
        expect(layout.getPageTop(2)).toBe(beforePageTwo);
        expect(layout.getPageTop(3)).toBe(
            beforePageThree - beforePageTwoHeight + layout.getPageHeight(2),
        );
    });

    it('finds pages at exact offset boundaries and snapshots shared geometry', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 3,
            renderWidth: 100,
        });
        layout.updatePageAspect(1, 1);
        layout.updatePageAspect(2, 2);
        layout.updatePageAspect(3, 1);

        expect(layout.resolvePageAtOffset(0)).toBe(1);
        expect(layout.resolvePageAtOffset(layout.getPageTop(2))).toBe(2);
        expect(layout.resolvePageAtOffset(layout.getPageTop(3))).toBe(3);
        expect(layout.resolvePageAtOffset(Number.MAX_SAFE_INTEGER)).toBe(3);
        expect(layout.snapshot().totalHeight).toBe(layout.getTotalHeight());
    });

    it('can adopt the first measured aspect for unknown PDF placeholders and later invalidate it', () => {
        const layout = new DocumentThumbnailLayout({
            adoptFirstAspectAsEstimate: true,
            pageCount: 100,
            renderWidth: 120,
        });

        expect(layout.updatePageAspect(2, 1.5)).toBe(true);
        expect(layout.getPageAspect(1)).toBe(1.5);
        expect(layout.getPageAspect(100)).toBe(1.5);
        expect(layout.updatePageAspect(1, 2)).toBe(true);
        expect(layout.updatePageAspect(1, null)).toBe(true);
        expect(layout.getPageAspect(1)).toBe(1.5);
    });

    it('does not apply the first adopted aspect delta twice', () => {
        const layout = new DocumentThumbnailLayout({
            adoptFirstAspectAsEstimate: true,
            itemChromeHeight: 30,
            pageCount: 3,
            renderWidth: 120,
        });

        expect(layout.updatePageAspect(1, 1.5)).toBe(true);
        expect(layout.snapshot()).toEqual({
            heights: [
                210,
                210,
                210,
            ],
            tops: [
                0,
                218,
                436,
            ],
            totalHeight: 646,
        });
    });
});
