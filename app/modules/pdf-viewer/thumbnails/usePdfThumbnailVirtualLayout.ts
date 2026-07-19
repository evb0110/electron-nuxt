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
    const aspectRatios = shallowRef<Array<number | null>>([]);
    const revision = ref(0);
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
        aspectRatios.value[page - 1] = aspectRatio;
        triggerRef(aspectRatios);
        if (layout.value.updatePageAspect(page, aspectRatio)) {
            commitLayoutReaction(anchor);
        }
    }

    function clearAspectRatios() {
        const anchor = options.captureAnchor();
        aspectRatios.value = [];
        layout.value.resetDocument({
            itemChromeHeight: itemChromeHeight.value,
            pageCount: options.pageCount.value,
            renderWidth: layoutWidth.value,
        });
        commitLayoutReaction(anchor);
    }

    watch([
        options.pageCount,
        itemChromeHeight,
        layoutWidth,
    ], () => {
        const anchor = options.captureAnchor();
        layout.value.reset({
            itemChromeHeight: itemChromeHeight.value,
            pageCount: options.pageCount.value,
            renderWidth: layoutWidth.value,
        });
        commitLayoutReaction(anchor);
    }, {flush: 'sync'});

    function getPageTop(page: number) {
        void revision.value;
        return layout.value.getPageTop(page);
    }

    function resolvePageAtOffset(offset: number) {
        void revision.value;
        return layout.value.resolvePageAtOffset(offset);
    }

    function resolveInsertionIndex(offset: number) {
        void revision.value;
        return layout.value.resolveInsertionIndex(offset);
    }

    const contentHeight = computed(() => {
        void revision.value;
        return layout.value.getTotalHeight();
    });

    return {
        aspectRatios,
        clearAspectRatios,
        contentHeight,
        getPageTop,
        itemChromeHeight,
        layout,
        layoutWidth,
        resolveInsertionIndex,
        resolvePageAtOffset,
        updateAspectRatio,
    };
};
