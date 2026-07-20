export const DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT = 30;
const DEFAULT_ITEM_GAP = 8;

export const DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO = 297 / 210;

export interface IDocumentThumbnailVirtualRange {
    endPage: number;
    startPage: number;
}

export interface IDocumentThumbnailLayoutAnchor {
    offset: number;
    page: number;
}

export interface IDocumentThumbnailLayoutSnapshot {
    heights: number[];
    tops: number[];
    totalHeight: number;
}

interface IDocumentThumbnailLayoutOptions {
    adoptFirstAspectAsEstimate?: boolean;
    estimatedAspectRatio?: number;
    itemChromeHeight?: number;
    itemGap?: number;
    pageCount: number;
    renderWidth: number;
}

function normalizePositive(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Source-agnostic thumbnail geometry with O(log N) aspect updates and offset lookup.
 * Aspect ratios are expressed as height / width, matching page metrics and raster leases.
 */
export class DocumentThumbnailLayout {
    private adoptFirstAspectAsEstimate: boolean;
    private readonly exactAspectRatios = new Map<number, number>();
    private readonly exactChromeHeights = new Map<number, number>();
    private readonly heights: number[] = [];
    private readonly tree: number[] = [0];
    private estimatedAspectRatio: number;
    private itemChromeHeight: number;
    private itemGap: number;
    private pageCount: number;
    private renderWidth: number;

    constructor(options: IDocumentThumbnailLayoutOptions) {
        this.adoptFirstAspectAsEstimate = options.adoptFirstAspectAsEstimate ?? false;
        this.pageCount = Math.max(0, Math.trunc(options.pageCount));
        this.renderWidth = normalizePositive(options.renderWidth, 1);
        this.estimatedAspectRatio = normalizePositive(
            options.estimatedAspectRatio ?? DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO,
            DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO,
        );
        this.itemChromeHeight = Math.max(
            0,
            options.itemChromeHeight ?? DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT,
        );
        this.itemGap = Math.max(0, options.itemGap ?? DEFAULT_ITEM_GAP);
        this.rebuild();
    }

    reset(options: Partial<IDocumentThumbnailLayoutOptions> & Pick<IDocumentThumbnailLayoutOptions, 'pageCount' | 'renderWidth'>) {
        this.pageCount = Math.max(0, Math.trunc(options.pageCount));
        this.renderWidth = normalizePositive(options.renderWidth, 1);
        if (options.estimatedAspectRatio !== undefined) {
            this.estimatedAspectRatio = normalizePositive(
                options.estimatedAspectRatio,
                DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO,
            );
        }
        if (options.itemChromeHeight !== undefined) {
            this.itemChromeHeight = Math.max(0, options.itemChromeHeight);
        }
        if (options.itemGap !== undefined) {
            this.itemGap = Math.max(0, options.itemGap);
        }
        if (options.adoptFirstAspectAsEstimate !== undefined) {
            this.adoptFirstAspectAsEstimate = options.adoptFirstAspectAsEstimate;
        }
        for (const page of this.exactAspectRatios.keys()) {
            if (page > this.pageCount) this.exactAspectRatios.delete(page);
        }
        for (const page of this.exactChromeHeights.keys()) {
            if (page > this.pageCount) this.exactChromeHeights.delete(page);
        }
        this.rebuild();
    }

    resetDocument(options: IDocumentThumbnailLayoutOptions) {
        this.exactAspectRatios.clear();
        this.exactChromeHeights.clear();
        this.estimatedAspectRatio = normalizePositive(
            options.estimatedAspectRatio ?? DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO,
            DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO,
        );
        this.reset(options);
    }

    setEstimatedAspectRatio(aspectRatio: number) {
        const normalized = normalizePositive(aspectRatio, this.estimatedAspectRatio);
        if (normalized === this.estimatedAspectRatio) {
            return false;
        }
        this.estimatedAspectRatio = normalized;
        this.rebuild();
        return true;
    }

    updatePageAspect(page: number, aspectRatio: number | null) {
        if (page < 1 || page > this.pageCount) {
            return false;
        }
        const previousHeight = this.heights[page - 1] ?? 0;
        if (aspectRatio === null) {
            this.exactAspectRatios.delete(page);
        } else {
            const normalized = normalizePositive(aspectRatio, this.estimatedAspectRatio);
            if (
                this.adoptFirstAspectAsEstimate
                && this.exactAspectRatios.size === 0
                && this.estimatedAspectRatio !== normalized
            ) {
                this.estimatedAspectRatio = normalized;
                this.exactAspectRatios.set(page, normalized);
                this.rebuild();
                return true;
            }
            this.exactAspectRatios.set(page, normalized);
        }
        const nextHeight = this.resolvePageHeight(page);
        if (nextHeight === previousHeight) {
            return false;
        }
        this.heights[page - 1] = nextHeight;
        this.add(page, nextHeight - previousHeight);
        return true;
    }

    updatePageChromeHeight(page: number, chromeHeight: number | null) {
        if (page < 1 || page > this.pageCount) {
            return false;
        }
        const previousHeight = this.heights[page - 1] ?? 0;
        if (chromeHeight === null) {
            this.exactChromeHeights.delete(page);
        } else {
            this.exactChromeHeights.set(page, Math.max(0, chromeHeight));
        }
        const nextHeight = this.resolvePageHeight(page);
        if (nextHeight === previousHeight) {
            return false;
        }
        this.heights[page - 1] = nextHeight;
        this.add(page, nextHeight - previousHeight);
        return true;
    }

    getPageAspect(page: number) {
        return this.exactAspectRatios.get(page) ?? this.estimatedAspectRatio;
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

    snapshot(): IDocumentThumbnailLayoutSnapshot {
        let top = 0;
        const heights: number[] = [];
        const tops: number[] = [];
        for (let page = 1; page <= this.pageCount; page += 1) {
            const height = this.getPageHeight(page);
            heights.push(height);
            tops.push(top);
            top += height + (page < this.pageCount ? this.itemGap : 0);
        }
        return {
            heights,
            tops,
            totalHeight: top,
        };
    }

    resolvePageAtOffset(offset: number) {
        if (this.pageCount === 0) {
            return null;
        }
        const target = Math.max(0, offset);
        let index = 0;
        let prefix = 0;
        let step = 1;
        while (step * 2 <= this.pageCount) step *= 2;
        for (; step > 0; step = Math.trunc(step / 2)) {
            const candidate = index + step;
            if (candidate <= this.pageCount && prefix + this.tree[candidate]! <= target) {
                index = candidate;
                prefix += this.tree[candidate]!;
            }
        }
        return Math.min(this.pageCount, index + 1);
    }

    resolveInsertionIndex(offset: number) {
        const page = this.resolvePageAtOffset(offset);
        if (page === null) {
            return 0;
        }
        return offset < this.getPageTop(page) + this.getPageHeight(page) / 2
            ? page - 1
            : page;
    }

    resolveVirtualRange(scrollTop: number, viewportHeight: number, overscanPx: number): IDocumentThumbnailVirtualRange {
        if (this.pageCount === 0) {
            return {
                startPage: 0,
                endPage: -1,
            };
        }
        const startPage = this.resolvePageAtOffset(Math.max(0, scrollTop - Math.max(0, overscanPx))) ?? 1;
        const endPage = this.resolvePageAtOffset(
            Math.max(0, scrollTop + Math.max(1, viewportHeight) + Math.max(0, overscanPx)),
        ) ?? this.pageCount;
        return {
            startPage: Math.max(1, startPage),
            endPage: Math.min(this.pageCount, Math.max(startPage, endPage)),
        };
    }

    captureAnchor(scrollTop: number): IDocumentThumbnailLayoutAnchor | null {
        const page = this.resolvePageAtOffset(scrollTop);
        return page === null ? null : {
            page,
            offset: scrollTop - this.getPageTop(page),
        };
    }

    resolveAnchorScrollTop(anchor: IDocumentThumbnailLayoutAnchor | null) {
        if (!anchor || this.pageCount === 0) {
            return 0;
        }
        const page = Math.min(this.pageCount, Math.max(1, anchor.page));
        return Math.max(0, this.getPageTop(page) + anchor.offset);
    }

    private resolvePageHeight(page: number) {
        return Math.max(1, Math.ceil(
            this.renderWidth * this.getPageAspect(page)
            + (this.exactChromeHeights.get(page) ?? this.itemChromeHeight),
        ));
    }

    private rebuild() {
        this.tree.length = this.pageCount + 1;
        this.tree.fill(0);
        this.heights.length = this.pageCount;
        for (let page = 1; page <= this.pageCount; page += 1) {
            const height = this.resolvePageHeight(page);
            this.heights[page - 1] = height;
            this.tree[page] = height + (page < this.pageCount ? this.itemGap : 0);
        }
        for (let page = 1; page <= this.pageCount; page += 1) {
            const parent = page + (page & -page);
            if (parent <= this.pageCount) {
                this.tree[parent] = (this.tree[parent] ?? 0) + (this.tree[page] ?? 0);
            }
        }
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
