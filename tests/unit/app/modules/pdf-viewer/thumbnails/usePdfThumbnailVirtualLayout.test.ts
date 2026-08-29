import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import {usePdfThumbnailVirtualLayout} from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailVirtualLayout';
import {DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT} from '@app/utils/document-viewer/thumbnails/documentThumbnailLayout';

describe('usePdfThumbnailVirtualLayout', () => {
    it('keeps aspect ratios sparse for pages late in a large document', () => {
        const pageCount = ref(1_000_000);
        const scheduleReaction = vi.fn();
        const layout = usePdfThumbnailVirtualLayout({
            captureAnchor: () => null,
            pageCount: computed(() => pageCount.value),
            scheduleReaction,
        });

        expect(layout.aspectRatios.value).toBeInstanceOf(Map);
        expect(layout.aspectRatios.value.size).toBe(0);
        expect(layout.layout.value.getLoadedBlockCount()).toBe(0);

        layout.updateAspectRatio(999_999, 1.8);

        expect(layout.aspectRatios.value.get(999_999)).toBe(1.8);
        expect(layout.aspectRatios.value.size).toBe(1);
        expect(layout.layout.value.getLoadedBlockCount()).toBe(1);
        expect(scheduleReaction).toHaveBeenCalledTimes(1);

        layout.updateAspectRatio(999_999, null);

        expect(layout.aspectRatios.value.has(999_999)).toBe(false);
        expect(layout.aspectRatios.value.size).toBe(0);
    });

    it('resets sparse aspect ratios without allocating by page count', () => {
        const pageCount = ref(1_000_000);
        const layout = usePdfThumbnailVirtualLayout({
            captureAnchor: () => null,
            pageCount,
            scheduleReaction: () => {},
        });

        layout.updateAspectRatio(1, 1.2);
        layout.updateAspectRatio(250_000, 1.5);
        expect(layout.aspectRatios.value.size).toBe(2);

        layout.clearAspectRatios();

        expect(layout.aspectRatios.value.size).toBe(0);
        expect(layout.layout.value.getLoadedBlockCount()).toBe(0);
        expect(layout.contentHeight.value).toBeGreaterThan(0);
    });

    it('maps the last page into a bounded physical segment', () => {
        const pageCount = ref(138_000);
        const layout = usePdfThumbnailVirtualLayout({
            captureAnchor: () => null,
            pageCount,
            scheduleReaction: () => {},
        });

        layout.setActiveScrollSegmentForPage(pageCount.value);

        expect(layout.activeScrollSegmentIndex.value).toBeGreaterThan(0);
        expect(layout.contentHeight.value).toBeLessThanOrEqual(DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT);
        expect(layout.resolvePageAtOffset(layout.contentHeight.value)).toBe(pageCount.value);
        expect(layout.getPageTop(pageCount.value)).toBeLessThan(layout.contentHeight.value);

        const transition = layout.resolveScrollSegmentTransition(
            layout.contentHeight.value,
            0,
            500,
        );
        expect(transition).toBeNull();
    });
});
