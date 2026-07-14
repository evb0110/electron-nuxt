import type {Ref} from 'vue';
import type {
    IDocumentPageMetrics,
    IDocumentPageSource,
    IDocumentSurfaceLease,
} from '@app/utils/document-viewer/source/documentPageSource';
import {
    DocumentThumbnailLayout,
    type IDocumentThumbnailVirtualRange,
} from '@app/utils/document-viewer/thumbnails/documentThumbnailLayout';
import {
    resolveThumbnailOutputScale,
    resolveThumbnailRasterWidth,
    resolveThumbnailRenderWidthFromStyles,
} from '@app/utils/document-viewer/thumbnails/documentThumbnailRenderMetrics';
import {
    createDocumentThumbnailScheduler,
    type IDocumentThumbnailCommittedState,
    type IDocumentThumbnailDemand,
    type TDocumentThumbnailQuality,
} from '@app/utils/document-viewer/thumbnails/documentThumbnailScheduler';
import {createDocumentThumbnailResizeAnchorLifecycle} from '@app/utils/document-viewer/thumbnails/createDocumentThumbnailResizeAnchorLifecycle';
import {
    resolveDocumentThumbnailPageBounds,
    resolveDocumentThumbnailRevealScrollTop,
} from '@app/utils/document-viewer/thumbnails/documentThumbnailViewport';

const MIN_CSS_WIDTH = 96;
const VIRTUAL_OVERSCAN_PX = 700;
const RENDER_OVERSCAN_PX = 420;
const CURRENT_NEIGHBOR_COUNT = 2;
const SCROLL_SETTLE_MS = 160;
const RESIZE_SETTLE_MS = 140;

export interface IDocumentThumbnailVirtualItem {
    aspectRatio: string;
    height: number;
    pageNumber: number;
    top: number;
}

interface IUseDocumentThumbnailControllerOptions {
    currentPage: Ref<number>;
    isActive: Ref<boolean>;
    isResizing: Ref<boolean>;
    scrollRoot: Ref<HTMLElement | null>;
    source: Ref<IDocumentPageSource | null>;
}

function prepareSurface(lease: IDocumentSurfaceLease, signal: AbortSignal) {
    if (typeof lease.surface !== 'string') {
        return Promise.resolve();
    }
    const image = new Image();
    image.src = lease.surface;
    if (typeof image.decode === 'function') {
        return image.decode().then(() => signal.throwIfAborted());
    }
    return new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        image.onload = () => {
            signal.removeEventListener('abort', abort);
            resolve();
        };
        image.onerror = () => {
            signal.removeEventListener('abort', abort);
            reject(new Error('Thumbnail decode failed'));
        };
    }).then(() => signal.throwIfAborted());
}

function addRange(target: Set<number>, range: IDocumentThumbnailVirtualRange, pageCount: number) {
    for (
        let page = Math.max(1, range.startPage);
        page <= Math.min(pageCount, range.endPage);
        page += 1
    ) target.add(page);
}

export const useDocumentThumbnailController = (options: IUseDocumentThumbnailControllerOptions) => {
    const states = shallowReactive(new Map<number, IDocumentThumbnailCommittedState>());
    const layoutRevision = ref(0);
    const viewportRevision = ref(0);
    const isScrolling = ref(false);
    const isVisible = ref(false);
    const cssWidth = ref(MIN_CSS_WIDTH);
    const settledCssWidth = ref(MIN_CSS_WIDTH);
    const metricsCache = new Map<number, Promise<IDocumentPageMetrics>>();
    const layout = new DocumentThumbnailLayout({
        pageCount: 0,
        renderWidth: MIN_CSS_WIDTH,
    });
    let resizeObserver: ResizeObserver | null = null;
    let scheduledFrame: number | null = null;
    let resizeSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let hasSourceAspectEstimate = false;
    let mounted = false;

    function captureResizeAnchor() {
        const root = options.scrollRoot.value;
        return root && root.clientHeight > 0 ? layout.captureAnchor(root.scrollTop) : null;
    }

    function restoreResizeAnchor(anchor: ReturnType<typeof layout.captureAnchor>) {
        const root = options.scrollRoot.value;
        if (!root || !anchor || root.clientHeight <= 0) {
            return false;
        }
        const nextScrollTop = Math.min(
            Math.max(0, layout.getTotalHeight() - root.clientHeight),
            layout.resolveAnchorScrollTop(anchor),
        );
        if (Math.abs(root.scrollTop - nextScrollTop) >= 1) {
            root.scrollTop = nextScrollTop;
        }
        viewportRevision.value += 1;
        return true;
    }

    const resizeAnchorLifecycle = createDocumentThumbnailResizeAnchorLifecycle({
        capture: captureResizeAnchor,
        restore: restoreResizeAnchor,
    });

    function applyPageMetrics(pageNumber: number, metrics: IDocumentPageMetrics) {
        if (metrics.widthPoints <= 0 || metrics.heightPoints <= 0) {
            return;
        }
        const root = options.scrollRoot.value;
        const anchor = resizeAnchorLifecycle.read()
            ?? (root ? layout.captureAnchor(root.scrollTop) : null);
        const aspectRatio = metrics.heightPoints / metrics.widthPoints;
        const estimateChanged = !hasSourceAspectEstimate && layout.setEstimatedAspectRatio(aspectRatio);
        hasSourceAspectEstimate = true;
        const pageChanged = layout.updatePageAspect(pageNumber, aspectRatio);
        if (!estimateChanged && !pageChanged) {
            return;
        }
        layoutRevision.value += 1;
        if (root && anchor) root.scrollTop = layout.resolveAnchorScrollTop(anchor);
        if (resizeAnchorLifecycle.isActive()) resizeAnchorLifecycle.preserve();
    }

    async function getPageMetrics(
        source: IDocumentPageSource,
        pageNumber: number,
        signal: AbortSignal,
    ) {
        let promise = metricsCache.get(pageNumber);
        if (!promise) {
            promise = source.getPageMetrics(pageNumber, signal);
            metricsCache.set(pageNumber, promise);
            promise.catch(() => {
                if (metricsCache.get(pageNumber) === promise) metricsCache.delete(pageNumber);
            });
        }
        const metrics = await promise;
        signal.throwIfAborted();
        if (options.source.value === source) applyPageMetrics(pageNumber, metrics);
        return metrics;
    }

    const scheduler = createDocumentThumbnailScheduler({
        maxConcurrency: 3,
        onStateChange(pageNumber, state) {
            if (state) states.set(pageNumber, state);
            else states.delete(pageNumber);
        },
        prepareSurface,
        async render(request) {
            const source = options.source.value;
            const provider = source?.thumbnailProvider;
            if (!source || !provider) throw new Error('Thumbnail provider is unavailable');
            await getPageMetrics(source, request.pageNumber, request.signal);
            request.signal.throwIfAborted();
            return provider.renderThumbnail(request);
        },
    });

    function measureCssWidth() {
        const root = options.scrollRoot.value;
        if (!root || root.clientWidth <= 0) {
            return null;
        }
        const item = root.querySelector<HTMLElement>('.document-thumbnail-list__item');
        return resolveThumbnailRenderWidthFromStyles({
            containerClientWidth: root.clientWidth,
            containerStyle: getComputedStyle(root),
            minWidth: MIN_CSS_WIDTH,
            thumbnailStyle: item ? getComputedStyle(item) : null,
        });
    }

    function updateLayoutWidth(nextWidth: number) {
        if (nextWidth === cssWidth.value) {
            return;
        }
        const root = options.scrollRoot.value;
        const anchor = resizeAnchorLifecycle.read()
            ?? (root ? layout.captureAnchor(root.scrollTop) : null);
        cssWidth.value = nextWidth;
        layout.reset({
            pageCount: options.source.value?.pageCount ?? 0,
            renderWidth: nextWidth,
        });
        layoutRevision.value += 1;
        if (root && anchor) root.scrollTop = layout.resolveAnchorScrollTop(anchor);
        if (resizeAnchorLifecycle.isActive()) resizeAnchorLifecycle.preserve();
    }

    function measureViewport() {
        const root = options.scrollRoot.value;
        const nextVisible = Boolean(root && root.clientWidth > 0 && root.clientHeight > 0);
        isVisible.value = nextVisible;
        const measuredWidth = measureCssWidth();
        if (measuredWidth !== null) {
            updateLayoutWidth(measuredWidth);
            if (settledCssWidth.value === MIN_CSS_WIDTH && measuredWidth !== MIN_CSS_WIDTH) {
                settledCssWidth.value = measuredWidth;
            }
        }
        if (resizeAnchorLifecycle.isActive()) resizeAnchorLifecycle.preserve();
        viewportRevision.value += 1;
    }

    function resolveRange(overscanPx: number) {
        const root = options.scrollRoot.value;
        if (!root || !isVisible.value) {
            return {
                startPage: 0,
                endPage: -1,
            };
        }
        return layout.resolveVirtualRange(root.scrollTop, root.clientHeight, overscanPx);
    }

    function buildDemand() {
        const source = options.source.value;
        if (!source?.thumbnailProvider || !isVisible.value) {
            return [];
        }
        const visibleRange = resolveRange(0);
        const retainedRange = resolveRange(RENDER_OVERSCAN_PX);
        const visiblePages = new Set<number>();
        const retainedPages = new Set<number>();
        addRange(visiblePages, visibleRange, source.pageCount);
        addRange(retainedPages, retainedRange, source.pageCount);
        const currentPage = Math.min(source.pageCount, Math.max(1, options.currentPage.value));
        for (
            let page = Math.max(1, currentPage - CURRENT_NEIGHBOR_COUNT);
            page <= Math.min(source.pageCount, currentPage + CURRENT_NEIGHBOR_COUNT);
            page += 1
        ) retainedPages.add(page);

        const settledScale = resolveThumbnailOutputScale(window.devicePixelRatio || 1);
        const transient = isScrolling.value || options.isResizing.value;
        const quality: TDocumentThumbnailQuality = transient ? 'transient' : 'settled';
        const rasterCssWidth = transient ? settledCssWidth.value : cssWidth.value;
        const normalWidth = resolveThumbnailRasterWidth(rasterCssWidth * (transient ? 1 : settledScale));
        const currentWidth = resolveThumbnailRasterWidth(cssWidth.value * settledScale);
        const demand: IDocumentThumbnailDemand[] = [];
        for (const pageNumber of retainedPages) {
            const isCurrent = pageNumber === currentPage;
            const isVisiblePage = visiblePages.has(pageNumber);
            demand.push({
                distance: Math.abs(pageNumber - currentPage),
                pageNumber,
                priority: 'thumbnail',
                quality: isCurrent ? 'settled' : quality,
                rank: isCurrent ? 0 : isVisiblePage ? 1 : 2,
                widthPx: isCurrent ? currentWidth : normalWidth,
            });
        }
        return demand;
    }

    function refresh() {
        scheduledFrame = null;
        measureViewport();
        scheduler.reconcile(buildDemand());
    }

    function scheduleRefresh() {
        if (!mounted || scheduledFrame !== null) {
            return;
        }
        scheduledFrame = requestAnimationFrame(refresh);
    }

    function settleRasterWidth() {
        settledCssWidth.value = cssWidth.value;
        scheduleRefresh();
    }

    function scheduleResizeSettle() {
        if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
        if (options.isResizing.value) {
            return;
        }
        resizeSettleTimer = setTimeout(settleRasterWidth, RESIZE_SETTLE_MS);
    }

    function handleScroll() {
        isScrolling.value = true;
        viewportRevision.value += 1;
        if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
        scheduleRefresh();
        scrollSettleTimer = setTimeout(() => {
            isScrolling.value = false;
            scheduleRefresh();
        }, SCROLL_SETTLE_MS);
    }

    function revealCurrentPage() {
        const source = options.source.value;
        const root = options.scrollRoot.value;
        if (!source || !root || !options.isActive.value || root.clientHeight <= 0) {
            return;
        }
        const page = Math.min(source.pageCount, Math.max(1, options.currentPage.value));
        const nextScrollTop = resolveDocumentThumbnailRevealScrollTop(
            root,
            resolveDocumentThumbnailPageBounds(page, layout),
        );
        if (nextScrollTop !== null) root.scrollTop = nextScrollTop;
    }

    const virtualItems = computed<IDocumentThumbnailVirtualItem[]>(() => {
        void layoutRevision.value;
        void viewportRevision.value;
        const source = options.source.value;
        if (!source || !isVisible.value) {
            return [];
        }
        const pages = new Set<number>();
        addRange(pages, resolveRange(VIRTUAL_OVERSCAN_PX), source.pageCount);
        const currentPage = Math.min(source.pageCount, Math.max(1, options.currentPage.value));
        for (
            let page = Math.max(1, currentPage - CURRENT_NEIGHBOR_COUNT);
            page <= Math.min(source.pageCount, currentPage + CURRENT_NEIGHBOR_COUNT);
            page += 1
        ) pages.add(page);
        return [...pages].sort((left, right) => left - right).map(pageNumber => ({
            aspectRatio: String(1 / layout.getPageAspect(pageNumber)),
            height: layout.getPageHeight(pageNumber),
            pageNumber,
            top: layout.getPageTop(pageNumber),
        }));
    });

    const contentHeight = computed(() => {
        void layoutRevision.value;
        return `${String(layout.getTotalHeight())}px`;
    });

    watch(
        options.source,
        async source => {
            scheduler.reset();
            states.clear();
            metricsCache.clear();
            hasSourceAspectEstimate = false;
            layout.resetDocument({
                pageCount: source?.pageCount ?? 0,
                renderWidth: cssWidth.value,
            });
            layoutRevision.value += 1;
            await nextTick();
            measureViewport();
            revealCurrentPage();
            scheduleRefresh();
        },
        {immediate: true},
    );
    watch(options.currentPage, async () => {
        await nextTick();
        revealCurrentPage();
        viewportRevision.value += 1;
        scheduleRefresh();
    });
    watch(options.isActive, async active => {
        if (!active) {
            return;
        }
        await nextTick();
        measureViewport();
        revealCurrentPage();
        viewportRevision.value += 1;
        scheduleRefresh();
    });
    watch(options.isResizing, resizing => {
        if (resizing) {
            resizeAnchorLifecycle.begin();
            if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
            scheduleRefresh();
        } else {
            void resizeAnchorLifecycle.finish().then(scheduleRefresh);
            scheduleResizeSettle();
        }
    });

    onMounted(() => {
        mounted = true;
        resizeObserver = new ResizeObserver(() => {
            const wasVisible = isVisible.value;
            measureViewport();
            if (!wasVisible && isVisible.value && options.isActive.value) revealCurrentPage();
            scheduleRefresh();
            scheduleResizeSettle();
        });
        const root = options.scrollRoot.value;
        if (root) resizeObserver.observe(root);
        measureViewport();
        revealCurrentPage();
        scheduleRefresh();
    });
    onBeforeUnmount(() => {
        mounted = false;
        if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
        if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
        if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
        resizeAnchorLifecycle.cancel();
        resizeObserver?.disconnect();
        scheduler.dispose();
        states.clear();
    });

    return {
        contentHeight,
        handleScroll,
        scheduleRefresh,
        states,
        virtualItems,
    };
};
