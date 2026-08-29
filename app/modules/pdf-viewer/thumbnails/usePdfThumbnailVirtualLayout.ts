import type {Ref} from 'vue';
import {THUMBNAIL_WIDTH} from '@app/constants/pdfLayout';
import {
    DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT,
    DocumentThumbnailLayout,
    type IDocumentThumbnailLayoutAnchor,
} from '@app/utils/document-viewer/thumbnails/documentThumbnailLayout';

interface IUsePdfThumbnailVirtualLayoutOptions {
    captureAnchor: () => IDocumentThumbnailLayoutAnchor | null;
    pageCount: Ref<number>;
    scheduleReaction: (anchor: IDocumentThumbnailLayoutAnchor | null) => void;
}

export const usePdfThumbnailVirtualLayout = (options: IUsePdfThumbnailVirtualLayoutOptions) => {
    const itemChromeHeight = ref(DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT);
    const layoutWidth = ref(THUMBNAIL_WIDTH);
    // Aspect ratios are sparse because PDF metadata arrives as pages render.
    // A page-indexed array would allocate a large logical range when a late
    // page is measured in a very large document.
    const aspectRatios = shallowRef(new Map<number, number>());
    const revision = ref(0);
    const activeScrollSegmentIndex = ref(0);
    const layout = shallowRef(new DocumentThumbnailLayout({
        adoptFirstAspectAsEstimate: true,
        itemChromeHeight: itemChromeHeight.value,
        pageCount: options.pageCount.value,
        renderWidth: layoutWidth.value,
    }));

    function commitLayoutReaction(anchor: IDocumentThumbnailLayoutAnchor | null) {
        revision.value += 1;
        options.scheduleReaction(anchor);
    }

    function updateAspectRatio(page: number, aspectRatio: number | null) {
        const anchor = options.captureAnchor();
        if (page < 1 || page > options.pageCount.value) {
            return;
        }
        if (aspectRatio === null) {
            aspectRatios.value.delete(page);
        } else {
            aspectRatios.value.set(page, aspectRatio);
        }
        triggerRef(aspectRatios);
        if (layout.value.updatePageAspect(page, aspectRatio)) {
            commitLayoutReaction(anchor);
        }
    }

    function clearAspectRatios() {
        const anchor = options.captureAnchor();
        aspectRatios.value = new Map();
        layout.value.resetDocument({
            itemChromeHeight: itemChromeHeight.value,
            pageCount: options.pageCount.value,
            renderWidth: layoutWidth.value,
        });
        activeScrollSegmentIndex.value = layout.value.getScrollSegmentIndexForPage(1);
        commitLayoutReaction(anchor);
    }

    watch([
        options.pageCount,
        itemChromeHeight,
        layoutWidth,
    ], () => {
        const anchor = options.captureAnchor();
        let pruned = false;
        for (const page of aspectRatios.value.keys()) {
            if (page > options.pageCount.value) {
                aspectRatios.value.delete(page);
                pruned = true;
            }
        }
        if (pruned) {
            triggerRef(aspectRatios);
        }
        layout.value.reset({
            itemChromeHeight: itemChromeHeight.value,
            pageCount: options.pageCount.value,
            renderWidth: layoutWidth.value,
        });
        activeScrollSegmentIndex.value = Math.min(
            Math.max(0, layout.value.getScrollSegmentCount() - 1),
            activeScrollSegmentIndex.value,
        );
        commitLayoutReaction(anchor);
    }, {flush: 'sync'});

    function getPageTop(page: number) {
        void revision.value;
        return layout.value.getPageTopInScrollSegment(page, activeScrollSegmentIndex.value);
    }

    function getPageBounds(page: number) {
        const top = Math.max(0, getPageTop(page));
        const height = Math.max(1, layout.value.getPageHeight(page));
        return {
            bottom: top + height,
            height,
            top,
        };
    }

    function getMaxScrollTop(clientHeight: number) {
        return Math.max(0, contentHeight.value - clientHeight);
    }

    function getViewport(container: HTMLElement) {
        return {
            clientHeight: container.clientHeight,
            scrollHeight: contentHeight.value,
            scrollTop: container.scrollTop,
        };
    }

    function resolvePageAtOffset(offset: number) {
        void revision.value;
        return layout.value.resolvePageAtScrollOffsetInSegment(offset, activeScrollSegmentIndex.value);
    }

    function resolveInsertionIndex(offset: number) {
        void revision.value;
        return layout.value.resolveInsertionIndexInScrollSegment(offset, activeScrollSegmentIndex.value);
    }

    function setActiveScrollSegment(index: number) {
        const segmentCount = layout.value.getScrollSegmentCount();
        const nextIndex = segmentCount === 0
            ? 0
            : Math.min(segmentCount - 1, Math.max(0, Math.trunc(index)));
        if (nextIndex === activeScrollSegmentIndex.value) {
            return false;
        }
        activeScrollSegmentIndex.value = nextIndex;
        revision.value += 1;
        return true;
    }

    function setActiveScrollSegmentForPage(page: number) {
        return setActiveScrollSegment(layout.value.getScrollSegmentIndexForPage(page));
    }

    function resolveScrollSegmentTransition(
        scrollTop: number,
        previousScrollTop: number,
        viewportHeight: number,
    ) {
        void revision.value;
        const transition = layout.value.resolveScrollSegmentTransition(
            scrollTop,
            previousScrollTop,
            viewportHeight,
            activeScrollSegmentIndex.value,
        );
        if (!transition) {
            return null;
        }
        setActiveScrollSegment(transition.segmentIndex);
        return transition;
    }

    const contentHeight = computed(() => {
        void revision.value;
        return layout.value.getScrollSegment(activeScrollSegmentIndex.value).height;
    });

    return {
        activeScrollSegmentIndex,
        aspectRatios,
        clearAspectRatios,
        contentHeight,
        getPageTop,
        getPageBounds,
        getMaxScrollTop,
        getViewport,
        itemChromeHeight,
        layout,
        layoutWidth,
        resolveInsertionIndex,
        resolvePageAtOffset,
        resolveScrollSegmentTransition,
        setActiveScrollSegment,
        setActiveScrollSegmentForPage,
        updateAspectRatio,
    };
};
