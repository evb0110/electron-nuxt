import {
    describe,
    expect,
    it,
} from 'vitest';
import { ThumbnailFenwickLayout } from '@app/modules/pdf-viewer/thumbnails/thumbnailFenwickLayout';
import { resolveThumbnailItemHeightFromAspect } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';

describe('ThumbnailFenwickLayout', () => {
    it('updates one page without rebuilding unrelated prefix geometry', () => {
        const layout = new ThumbnailFenwickLayout(10_000, 100, []);
        const beforePageTwo = layout.getPageTop(2);
        const beforePageThree = layout.getPageTop(3);

        expect(layout.updatePageAspect(2, 2)).toBe(true);
        expect(layout.getPageTop(2)).toBe(beforePageTwo);
        expect(layout.getPageTop(3)).toBe(
            beforePageThree - resolveThumbnailItemHeightFromAspect(null, 100)
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
});
