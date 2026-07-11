import { resolveThumbnailItemHeightFromAspect } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';

const THUMBNAIL_GAP_PX = 8;

/** Mutable thumbnail geometry with O(log N) point updates and offset lookup. */
export class ThumbnailFenwickLayout {
    private readonly tree: number[] = [0];
    private readonly heights: number[] = [];

    constructor(
        private pageCount = 0,
        private renderWidth = 0,
        aspectRatios: Array<number | null> = [],
    ) {
        this.reset(pageCount, renderWidth, aspectRatios);
    }

    reset(pageCount: number, renderWidth: number, aspectRatios: Array<number | null> = []) {
        this.pageCount = Math.max(0, Math.trunc(pageCount));
        this.renderWidth = renderWidth;
        this.tree.length = this.pageCount + 1;
        this.tree.fill(0);
        this.heights.length = this.pageCount;
        for (let page = 1; page <= this.pageCount; page += 1) {
            const height = resolveThumbnailItemHeightFromAspect(aspectRatios[page - 1], renderWidth);
            this.heights[page - 1] = height;
            this.add(page, height + (page < this.pageCount ? THUMBNAIL_GAP_PX : 0));
        }
    }

    updatePageAspect(page: number, aspectRatio: number | null) {
        if (page < 1 || page > this.pageCount) {
            return false;
        }
        const nextHeight = resolveThumbnailItemHeightFromAspect(aspectRatio, this.renderWidth);
        const previousHeight = this.heights[page - 1]!;
        if (nextHeight === previousHeight) {
            return false;
        }
        this.heights[page - 1] = nextHeight;
        this.add(page, nextHeight - previousHeight);
        return true;
    }

    getPageHeight(page: number) {
        return this.heights[page - 1] ?? 0;
    }

    getPageTop(page: number) {
        return page <= 1 ? 0 : this.prefix(page - 1);
    }

    getTotalHeight() {
        return this.prefix(this.pageCount);
    }

    resolvePageAtOffset(offset: number) {
        if (this.pageCount === 0) {
            return null;
        }
        const target = Math.max(0, offset);
        let index = 0;
        let prefix = 0;
        let step = 1;
        while (step * 2 <= this.pageCount) {
            step *= 2;
        }
        for (; step > 0; step = Math.trunc(step / 2)) {
            const candidate = index + step;
            if (candidate <= this.pageCount && prefix + this.tree[candidate]! <= target) {
                index = candidate;
                prefix += this.tree[candidate]!;
            }
        }
        return Math.min(this.pageCount, index + 1);
    }

    snapshot() {
        return {
            heights: Array.from({length: this.pageCount}, (_, index) => this.getPageHeight(index + 1)),
            tops: Array.from({length: this.pageCount}, (_, index) => this.getPageTop(index + 1)),
            totalHeight: this.getTotalHeight(),
        };
    }

    private add(page: number, delta: number) {
        for (let index = page; index <= this.pageCount; index += index & -index) {
            this.tree[index] = (this.tree[index] ?? 0) + delta;
        }
    }

    private prefix(page: number) {
        let total = 0;
        for (let index = page; index > 0; index -= index & -index) {
            total += this.tree[index] ?? 0;
        }
        return total;
    }
}
