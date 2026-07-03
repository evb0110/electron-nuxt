import type {
    ComputedRef,
    Ref,
} from 'vue';
import { useMutationObserver } from '@vueuse/core';
import type { TPdfSource } from '@app/types/pdfUi';
import type { PDFDocumentProxy } from 'pdfjs-dist';

interface IUsePdfViewerLoadingStateOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    viewerContainer: Ref<HTMLElement | null>;
    holdOverlayVisible?: Ref<boolean>;
}

export const usePdfViewerLoadingState = (options: IUsePdfViewerLoadingStateOptions) => {
    const {
        src,
        isLoading,
        pdfDocument,
        viewerContainer,
        holdOverlayVisible,
    } = options;

    const hasCompletedInitialRenderForCurrentSource = ref(false);
    const mutationObserverWindow = typeof window !== 'undefined'
        ? window
        : globalThis as Window & typeof globalThis;
    const initialRenderObserverTarget = computed(() => {
        if (
            !src.value
            || isLoading.value
            || !pdfDocument.value
            || hasCompletedInitialRenderForCurrentSource.value
        ) {
            return null;
        }

        return viewerContainer.value;
    });

    function hasRenderedCanvasInDom() {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }

        return Boolean(container.querySelector('.page_container--rendered .page_canvas canvas'));
    }

    function markInitialRenderCompleteIfReady() {
        if (hasCompletedInitialRenderForCurrentSource.value) {
            return true;
        }

        if (!hasRenderedCanvasInDom()) {
            return false;
        }

        hasCompletedInitialRenderForCurrentSource.value = true;
        return true;
    }

    useMutationObserver(
        initialRenderObserverTarget,
        markInitialRenderCompleteIfReady,
        {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
            window: mutationObserverWindow,
        },
    );

    watch(
        [
            () => src.value,
            isLoading,
            pdfDocument,
        ],
        async ([
            hasSrc,
            loading,
            document,
        ]) => {
            if (!hasSrc || loading || !document) {
                hasCompletedInitialRenderForCurrentSource.value = false;
                return;
            }

            await nextTick();
            markInitialRenderCompleteIfReady();
        },
        { immediate: true },
    );

    watch(viewerContainer, () => {
        if (
            !src.value
            || isLoading.value
            || !pdfDocument.value
            || hasCompletedInitialRenderForCurrentSource.value
        ) {
            return;
        }

        markInitialRenderCompleteIfReady();
    });

    const isViewerLoadingOverlayVisible = computed(() => (
        Boolean(src.value) && (
            isLoading.value
            || (
                Boolean(pdfDocument.value)
                && !hasCompletedInitialRenderForCurrentSource.value
            )
            || holdOverlayVisible?.value === true
        )
    ));

    return { isViewerLoadingOverlayVisible };
};
