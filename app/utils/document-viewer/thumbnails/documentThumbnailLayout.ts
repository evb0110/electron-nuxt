export const DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT = 30;
const DEFAULT_ITEM_GAP = 8;

export const DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO = 297 / 210;

/**
 * A loaded block is the only per-page geometry storage this layout creates.
 * Keeping the block small bounds the work needed to inspect a non-uniform
 * region while allowing documents with millions of pages to keep their
 * default geometry as scalars.
 */
export const DOCUMENT_THUMBNAIL_LAYOUT_BLOCK_SIZE = 128;
const DEFAULT_SNAPSHOT_PAGE_LIMIT = 256;

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

export interface IDocumentThumbnailLayoutSnapshotRange {
    endPage?: number;
    startPage?: number;
}

export interface IDocumentThumbnailLayoutOptions {
    adoptFirstAspectAsEstimate?: boolean;
    estimatedAspectRatio?: number;
    itemChromeHeight?: number;
    itemGap?: number;
    pageCount: number;
    renderWidth: number;
}

interface IThumbnailLayoutBlock {
    aspectOverrides: Map<number, number>;
    chromeOverrides: Map<number, number>;
    delta: number;
    heightDeltas: Map<number, number>;
    index: number;
}

interface IThumbnailLayoutBlockNode {
    block: IThumbnailLayoutBlock;
    key: number;
    left: IThumbnailLayoutBlockNode | null;
    priority: number;
    right: IThumbnailLayoutBlockNode | null;
    subtreeDelta: number;
}

function normalizePositive(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePageCount(value: number) {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeNonNegative(value: number, fallback: number) {
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function getBlockIndex(page: number) {
    return Math.trunc((page - 1) / DOCUMENT_THUMBNAIL_LAYOUT_BLOCK_SIZE);
}

function getBlockLocalPage(page: number) {
    return (page - 1) % DOCUMENT_THUMBNAIL_LAYOUT_BLOCK_SIZE;
}

function getBlockFirstPage(blockIndex: number) {
    return blockIndex * DOCUMENT_THUMBNAIL_LAYOUT_BLOCK_SIZE + 1;
}

function getBlockPriority(blockIndex: number) {
    // A stable integer mix keeps insertion order from turning the treap into
    // a list when pages are measured sequentially.
    let hash = Math.imul(blockIndex ^ 0x9e3779b9, 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 16), 0xc2b2ae35);
    return (hash ^ (hash >>> 16)) >>> 0;
}

function getSubtreeDelta(node: IThumbnailLayoutBlockNode | null) {
    return node?.subtreeDelta ?? 0;
}

function updateNode(node: IThumbnailLayoutBlockNode) {
    node.subtreeDelta = node.block.delta
        + getSubtreeDelta(node.left)
        + getSubtreeDelta(node.right);
}

function splitTree(
    root: IThumbnailLayoutBlockNode | null,
    key: number,
): [IThumbnailLayoutBlockNode | null, IThumbnailLayoutBlockNode | null] {
    if (!root) {
        return [
            null,
            null,
        ];
    }
    if (root.key < key) {
        const [
            rightOfLeft,
            right,
        ] = splitTree(root.right, key);
        root.right = rightOfLeft;
        updateNode(root);
        return [
            root,
            right,
        ];
    }
    const [
        left,
        leftOfRight,
    ] = splitTree(root.left, key);
    root.left = leftOfRight;
    updateNode(root);
    return [
        left,
        root,
    ];
}

function mergeTrees(
    left: IThumbnailLayoutBlockNode | null,
    right: IThumbnailLayoutBlockNode | null,
): IThumbnailLayoutBlockNode | null {
    if (!left) {
        return right;
    }
    if (!right) {
        return left;
    }
    if (left.priority > right.priority) {
        left.right = mergeTrees(left.right, right);
        updateNode(left);
        return left;
    }
    right.left = mergeTrees(left, right.left);
    updateNode(right);
    return right;
}

function insertTree(
    root: IThumbnailLayoutBlockNode | null,
    next: IThumbnailLayoutBlockNode,
): IThumbnailLayoutBlockNode {
    if (!root) {
        return next;
    }
    if (next.priority > root.priority) {
        const [
            left,
            right,
        ] = splitTree(root, next.key);
        next.left = left;
        next.right = right;
        updateNode(next);
        return next;
    }
    if (next.key < root.key) {
        root.left = insertTree(root.left, next);
    } else {
        root.right = insertTree(root.right, next);
    }
    updateNode(root);
    return root;
}

function removeTree(
    root: IThumbnailLayoutBlockNode | null,
    key: number,
): IThumbnailLayoutBlockNode | null {
    if (!root) {
        return null;
    }
    if (key === root.key) {
        return mergeTrees(root.left, root.right);
    }
    if (key < root.key) {
        root.left = removeTree(root.left, key);
    } else {
        root.right = removeTree(root.right, key);
    }
    updateNode(root);
    return root;
}

/**
 * Source-agnostic thumbnail geometry with sparse block updates and offset
 * lookup. Aspect ratios are expressed as height / width, matching page
 * metrics and raster leases.
 */
export class DocumentThumbnailLayout {
    private adoptFirstAspectAsEstimate: boolean;
    private estimatedAspectRatio: number;
    private itemChromeHeight: number;
    private itemGap: number;
    private pageCount: number;
    private renderWidth: number;
    private defaultPageHeight: number;
    private rootBlock: IThumbnailLayoutBlockNode | null = null;
    private readonly blockNodes = new Map<number, IThumbnailLayoutBlockNode>();
    private exactAspectCount = 0;

    constructor(options: IDocumentThumbnailLayoutOptions) {
        this.adoptFirstAspectAsEstimate = options.adoptFirstAspectAsEstimate ?? false;
        this.pageCount = normalizePageCount(options.pageCount);
        this.renderWidth = normalizePositive(options.renderWidth, 1);
        this.estimatedAspectRatio = normalizePositive(
            options.estimatedAspectRatio ?? DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO,
            DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO,
        );
        this.itemChromeHeight = normalizeNonNegative(
            options.itemChromeHeight ?? DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT,
            DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT,
        );
        this.itemGap = normalizeNonNegative(options.itemGap ?? DEFAULT_ITEM_GAP, DEFAULT_ITEM_GAP);
        this.defaultPageHeight = this.resolveDefaultPageHeight();
    }

    reset(options: Partial<IDocumentThumbnailLayoutOptions> & Pick<IDocumentThumbnailLayoutOptions, 'pageCount' | 'renderWidth'>) {
        this.pageCount = normalizePageCount(options.pageCount);
        this.renderWidth = normalizePositive(options.renderWidth, 1);
        if (options.estimatedAspectRatio !== undefined) {
            this.estimatedAspectRatio = normalizePositive(
                options.estimatedAspectRatio,
                DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO,
            );
        }
        if (options.itemChromeHeight !== undefined) {
            this.itemChromeHeight = normalizeNonNegative(options.itemChromeHeight, this.itemChromeHeight);
        }
        if (options.itemGap !== undefined) {
            this.itemGap = normalizeNonNegative(options.itemGap, this.itemGap);
        }
        if (options.adoptFirstAspectAsEstimate !== undefined) {
            this.adoptFirstAspectAsEstimate = options.adoptFirstAspectAsEstimate;
        }
        this.pruneBlocksToPageCount();
        this.defaultPageHeight = this.resolveDefaultPageHeight();
        this.refreshLoadedBlocks();
    }

    resetDocument(options: IDocumentThumbnailLayoutOptions) {
        this.rootBlock = null;
        this.blockNodes.clear();
        this.exactAspectCount = 0;
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
        this.defaultPageHeight = this.resolveDefaultPageHeight();
        this.refreshLoadedBlocks();
        return true;
    }

    updatePageAspect(page: number, aspectRatio: number | null) {
        if (!this.isValidPage(page)) {
            return false;
        }
        const block = this.getBlockForPage(page);
        const localPage = getBlockLocalPage(page);
        const previousHeight = this.getPageHeight(page);
        if (aspectRatio === null) {
            if (!block?.aspectOverrides.has(localPage)) {
                return false;
            }
            block.aspectOverrides.delete(localPage);
            this.exactAspectCount -= 1;
            this.refreshBlock(block);
        } else {
            const normalized = normalizePositive(aspectRatio, this.estimatedAspectRatio);
            if (
                this.adoptFirstAspectAsEstimate
                && this.exactAspectCount === 0
                && this.estimatedAspectRatio !== normalized
            ) {
                const firstBlock = block ?? this.ensureBlockForPage(page);
                firstBlock.aspectOverrides.set(localPage, normalized);
                this.exactAspectCount += 1;
                this.estimatedAspectRatio = normalized;
                this.defaultPageHeight = this.resolveDefaultPageHeight();
                this.refreshLoadedBlocks();
                return true;
            }
            const targetBlock = block ?? this.ensureBlockForPage(page);
            if (!targetBlock.aspectOverrides.has(localPage)) {
                this.exactAspectCount += 1;
            }
            targetBlock.aspectOverrides.set(localPage, normalized);
            this.refreshBlock(targetBlock);
        }
        return this.getPageHeight(page) !== previousHeight;
    }

    updatePageChromeHeight(page: number, chromeHeight: number | null) {
        if (!this.isValidPage(page)) {
            return false;
        }
        const block = this.getBlockForPage(page);
        const localPage = getBlockLocalPage(page);
        const previousHeight = this.getPageHeight(page);
        if (chromeHeight === null) {
            if (!block?.chromeOverrides.has(localPage)) {
                return false;
            }
            block.chromeOverrides.delete(localPage);
            this.refreshBlock(block);
        } else {
            const targetBlock = block ?? this.ensureBlockForPage(page);
            targetBlock.chromeOverrides.set(
                localPage,
                normalizeNonNegative(chromeHeight, this.itemChromeHeight),
            );
            this.refreshBlock(targetBlock);
        }
        return this.getPageHeight(page) !== previousHeight;
    }

    getPageAspect(page: number) {
        return this.getBlockForPage(page)?.aspectOverrides.get(getBlockLocalPage(page))
            ?? this.estimatedAspectRatio;
    }

    getPageHeight(page: number) {
        if (!this.isValidPage(page)) {
            return 0;
        }
        const block = this.getBlockForPage(page);
        return this.defaultPageHeight
            + (block?.heightDeltas.get(getBlockLocalPage(page)) ?? 0);
    }

    getPageTop(page: number) {
        if (page <= 1 || this.pageCount === 0) {
            return 0;
        }
        return this.prefix(Math.min(this.pageCount, Math.trunc(page) - 1));
    }

    getTotalHeight() {
        return this.prefix(this.pageCount);
    }

    /**
     * Returns absolute tops and heights for a requested page window. The
     * default call retains the old whole-document result for small documents,
     * but caps the result for large documents so it cannot allocate by
     * pageCount.
     */
    snapshot(
        rangeOrStart: IDocumentThumbnailLayoutSnapshotRange | number = 1,
        requestedEndPage?: number,
    ): IDocumentThumbnailLayoutSnapshot {
        const requestedStartPage = typeof rangeOrStart === 'number'
            ? rangeOrStart
            : rangeOrStart.startPage ?? 1;
        const startPage = this.normalizeSnapshotPage(requestedStartPage, 1);
        const explicitEndPage = typeof rangeOrStart === 'number'
            ? requestedEndPage !== undefined
            : rangeOrStart.endPage !== undefined;
        const defaultEndPage = !explicitEndPage && this.pageCount > DEFAULT_SNAPSHOT_PAGE_LIMIT
            ? startPage + DEFAULT_SNAPSHOT_PAGE_LIMIT - 1
            : this.pageCount;
        const endPage = this.normalizeSnapshotPage(
            typeof rangeOrStart === 'number'
                ? requestedEndPage ?? defaultEndPage
                : rangeOrStart.endPage ?? defaultEndPage,
            0,
        );
        const boundedEndPage = Math.min(this.pageCount, Math.max(startPage - 1, endPage));
        const heights: number[] = [];
        const tops: number[] = [];
        let top = this.getPageTop(startPage);
        for (let page = startPage; page <= boundedEndPage; page += 1) {
            const height = this.getPageHeight(page);
            heights.push(height);
            tops.push(top);
            top += height + (page < this.pageCount ? this.itemGap : 0);
        }
        return {
            heights,
            tops,
            totalHeight: this.getTotalHeight(),
        };
    }

    resolvePageAtOffset(offset: number) {
        if (this.pageCount === 0) {
            return null;
        }
        const target = Number.isNaN(offset) ? 0 : Math.max(0, offset);
        return this.resolvePageInTree(
            target,
            this.rootBlock,
            1,
            0,
            this.pageCount,
            this.getTotalHeight(),
            0,
        );
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
        const page = Math.min(this.pageCount, Math.max(1, Math.trunc(anchor.page)));
        return Math.max(0, this.getPageTop(page) + anchor.offset);
    }

    /** Exposed for allocation tests and diagnostics. */
    getLoadedBlockCount() {
        return this.blockNodes.size;
    }

    private isValidPage(page: number) {
        return Number.isInteger(page) && page >= 1 && page <= this.pageCount;
    }

    private normalizeSnapshotPage(page: number, fallback: number) {
        return Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : fallback;
    }

    private resolveDefaultPageHeight() {
        return Math.max(1, Math.ceil(
            this.renderWidth * this.estimatedAspectRatio + this.itemChromeHeight,
        ));
    }

    private resolvePageHeightFromBlock(block: IThumbnailLayoutBlock, localPage: number) {
        const aspectRatio = block.aspectOverrides.get(localPage) ?? this.estimatedAspectRatio;
        const chromeHeight = block.chromeOverrides.get(localPage) ?? this.itemChromeHeight;
        return Math.max(1, Math.ceil(this.renderWidth * aspectRatio + chromeHeight));
    }

    private getBlockForPage(page: number) {
        return this.blockNodes.get(getBlockIndex(page))?.block;
    }

    private ensureBlockForPage(page: number) {
        const blockIndex = getBlockIndex(page);
        const existing = this.blockNodes.get(blockIndex);
        if (existing) {
            return existing.block;
        }
        const block: IThumbnailLayoutBlock = {
            aspectOverrides: new Map(),
            chromeOverrides: new Map(),
            delta: 0,
            heightDeltas: new Map(),
            index: blockIndex,
        };
        const node: IThumbnailLayoutBlockNode = {
            block,
            key: blockIndex,
            left: null,
            priority: getBlockPriority(blockIndex),
            right: null,
            subtreeDelta: 0,
        };
        this.blockNodes.set(blockIndex, node);
        this.rootBlock = insertTree(this.rootBlock, node);
        return block;
    }

    private deleteBlock(block: IThumbnailLayoutBlock) {
        const node = this.blockNodes.get(block.index);
        if (!node) {
            return;
        }
        this.rootBlock = removeTree(this.rootBlock, block.index);
        this.blockNodes.delete(block.index);
    }

    private refreshBlock(block: IThumbnailLayoutBlock) {
        const previousDelta = block.delta;
        const knownPages = new Set([
            ...block.aspectOverrides.keys(),
            ...block.chromeOverrides.keys(),
        ]);
        block.heightDeltas.clear();
        block.delta = 0;
        for (const localPage of knownPages) {
            const page = getBlockFirstPage(block.index) + localPage;
            if (page > this.pageCount) {
                if (block.aspectOverrides.delete(localPage)) {
                    this.exactAspectCount -= 1;
                }
                block.chromeOverrides.delete(localPage);
                continue;
            }
            const delta = this.resolvePageHeightFromBlock(block, localPage) - this.defaultPageHeight;
            if (delta !== 0) {
                block.heightDeltas.set(localPage, delta);
                block.delta += delta;
            }
        }
        if (
            block.aspectOverrides.size === 0
            && block.chromeOverrides.size === 0
            && block.delta === 0
        ) {
            this.deleteBlock(block);
            return;
        }
        if (block.delta === previousDelta) {
            return;
        }
        const node = this.blockNodes.get(block.index);
        if (!node) {
            return;
        }
        this.rootBlock = removeTree(this.rootBlock, block.index);
        node.left = null;
        node.right = null;
        node.subtreeDelta = block.delta;
        this.rootBlock = insertTree(this.rootBlock, node);
    }

    private refreshLoadedBlocks() {
        const blocks = [...this.blockNodes.values()].map(node => node.block);
        for (const block of blocks) {
            this.refreshBlock(block);
        }
    }

    private pruneBlocksToPageCount() {
        const blocks = [...this.blockNodes.values()].map(node => node.block);
        for (const block of blocks) {
            const firstPage = getBlockFirstPage(block.index);
            if (firstPage > this.pageCount) {
                this.exactAspectCount -= block.aspectOverrides.size;
                this.deleteBlock(block);
                continue;
            }
            this.refreshBlock(block);
        }
    }

    private prefix(page: number) {
        const boundedPage = Math.max(0, Math.min(this.pageCount, Math.trunc(page)));
        if (boundedPage === 0) {
            return 0;
        }
        return boundedPage * (this.defaultPageHeight + this.itemGap)
            + this.prefixDelta(boundedPage)
            - (boundedPage === this.pageCount ? this.itemGap : 0);
    }

    private prefixDelta(page: number) {
        if (!this.rootBlock || page <= 0) {
            return 0;
        }
        const blockIndex = getBlockIndex(page);
        let node: IThumbnailLayoutBlockNode | null = this.rootBlock;
        let total = 0;
        while (node) {
            if (blockIndex < node.key) {
                node = node.left;
                continue;
            }
            total += getSubtreeDelta(node.left);
            if (blockIndex === node.key) {
                const firstPage = getBlockFirstPage(node.key);
                const lastLocalPage = page - firstPage;
                for (const [
                    localPage,
                    delta,
                ] of node.block.heightDeltas) {
                    if (localPage <= lastLocalPage) {
                        total += delta;
                    }
                }
                return total;
            }
            total += node.block.delta;
            node = node.right;
        }
        return total;
    }

    private resolvePageInTree(
        target: number,
        node: IThumbnailLayoutBlockNode | null,
        lowerPage: number,
        lowerTop: number,
        upperPage: number,
        _upperTop: number,
        inheritedDelta: number,
    ): number {
        if (!node) {
            return this.resolveDefaultPageInInterval(target, lowerPage, upperPage, lowerTop);
        }
        const blockStartPage = getBlockFirstPage(node.key);
        const blockEndPage = Math.min(
            this.pageCount,
            blockStartPage + DOCUMENT_THUMBNAIL_LAYOUT_BLOCK_SIZE - 1,
        );
        const deltaBeforeBlock = inheritedDelta + getSubtreeDelta(node.left);
        const blockTop = this.basePrefix(blockStartPage - 1) + deltaBeforeBlock;
        const blockBottom = this.basePrefix(blockEndPage)
            + deltaBeforeBlock
            + node.block.delta;
        if (target < blockTop) {
            if (node.left) {
                return this.resolvePageInTree(
                    target,
                    node.left,
                    lowerPage,
                    lowerTop,
                    blockStartPage - 1,
                    blockTop,
                    inheritedDelta,
                );
            }
            return this.resolveDefaultPageInInterval(
                target,
                lowerPage,
                blockStartPage - 1,
                lowerTop,
            );
        }
        if (target < blockBottom) {
            return this.resolvePageInBlock(target, node.block, blockStartPage, blockEndPage, blockTop);
        }
        if (node.right) {
            return this.resolvePageInTree(
                target,
                node.right,
                blockEndPage + 1,
                blockBottom,
                upperPage,
                _upperTop,
                deltaBeforeBlock + node.block.delta,
            );
        }
        return this.resolveDefaultPageInInterval(
            target,
            blockEndPage + 1,
            upperPage,
            blockBottom,
        );
    }

    private basePrefix(page: number) {
        const boundedPage = Math.max(0, Math.min(this.pageCount, Math.trunc(page)));
        if (boundedPage === 0) {
            return 0;
        }
        return boundedPage * (this.defaultPageHeight + this.itemGap)
            - (boundedPage === this.pageCount ? this.itemGap : 0);
    }

    private resolveDefaultPageInInterval(
        target: number,
        lowerPage: number,
        upperPage: number,
        lowerTop: number,
    ) {
        if (this.pageCount === 0) {
            return 0;
        }
        if (lowerPage > upperPage) {
            return Math.min(this.pageCount, Math.max(1, lowerPage - 1));
        }
        if (target < lowerTop) {
            return Math.min(this.pageCount, Math.max(1, lowerPage - 1));
        }
        const pageOffset = Math.floor((target - lowerTop) / (this.defaultPageHeight + this.itemGap));
        return Math.min(upperPage, Math.max(lowerPage, lowerPage + pageOffset));
    }

    private resolvePageInBlock(
        target: number,
        block: IThumbnailLayoutBlock,
        blockStartPage: number,
        blockEndPage: number,
        blockTop: number,
    ) {
        let top = blockTop;
        for (let page = blockStartPage; page <= blockEndPage; page += 1) {
            const height = this.defaultPageHeight
                + (block.heightDeltas.get(getBlockLocalPage(page)) ?? 0);
            const nextTop = top + height + (page < this.pageCount ? this.itemGap : 0);
            if (target < nextTop || page === this.pageCount) {
                return page;
            }
            top = nextTop;
        }
        return blockEndPage;
    }
}
