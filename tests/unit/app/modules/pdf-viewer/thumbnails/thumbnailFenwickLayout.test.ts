import {
    describe,
    expect,
    it,
} from 'vitest';
import { ThumbnailFenwickLayout } from '@app/modules/pdf-viewer/thumbnails/thumbnailFenwickLayout';
import { resolveThumbnailItemHeightFromAspect } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';

describe('ThumbnailFenwickLayout', () => {
    it('updates one page without rebuilding unrelated prefix geometry', () => {
        const estimatedAspectRatio = 1;
        const layout = new ThumbnailFenwickLayout(10_000, 100, [], estimatedAspectRatio);
        const beforePageTwo = layout.getPageTop(2);
        const beforePageThree = layout.getPageTop(3);

        expect(layout.updatePageAspect(2, 2)).toBe(true);
        expect(layout.getPageTop(2)).toBe(beforePageTwo);
        expect(layout.getPageTop(3)).toBe(
            beforePageThree - resolveThumbnailItemHeightFromAspect(estimatedAspectRatio, 100)
            + resolveThumbnailItemHeightFromAspect(2, 100),
        );
    });

    it('finds pages by offset at boundaries', () => {
        const layout = new ThumbnailFenwickLayout(3, 100, [
            1,
            2,
            1,
        ]);
        expect(layout.resolvePageAtOffset(0)).toBe(1);
        expect(layout.resolvePageAtOffset(layout.getPageTop(2))).toBe(2);
        expect(layout.resolvePageAtOffset(layout.getPageTop(3))).toBe(3);
        expect(layout.resolvePageAtOffset(Number.MAX_SAFE_INTEGER)).toBe(3);
    });

    it('reserves unknown pages with a representative aspect ratio', () => {
        const estimatedAspectRatio = 1.5;
        const layout = new ThumbnailFenwickLayout(
            100,
            120,
            [
                null,
                estimatedAspectRatio,
            ],
            estimatedAspectRatio,
        );
        const estimatedHeight = resolveThumbnailItemHeightFromAspect(estimatedAspectRatio, 120);

        expect(layout.getPageHeight(1)).toBe(estimatedHeight);
        expect(layout.getPageHeight(2)).toBe(estimatedHeight);
        expect(layout.getPageHeight(100)).toBe(estimatedHeight);
        expect(layout.updatePageAspect(1, estimatedAspectRatio)).toBe(false);
        expect(layout.updatePageAspect(1, 2)).toBe(true);
    });
});
