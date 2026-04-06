import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TPdfSource } from '@app/types/pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';

interface IUsePdfViewerLoadingStateOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    viewerContainer: Ref<HTMLElement | null>;
    holdOverlayVisible?: Ref<boolean>;
}

export function usePdfViewerLoadingState(options: IUsePdfViewerLoadingStateOptions) {
    const {
        src,
        isLoading,
        pdfDocument,
        viewerContainer,
        holdOverlayVisible,
    } = options;

    const hasCompletedInitialRenderForCurrentSource = ref(false);
    let initialRenderObserver: MutationObserver | null = null;

    function stopInitialRenderObserver() {
        initialRenderObserver?.disconnect();
        initialRenderObserver = null;
    }

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
        stopInitialRenderObserver();
        return true;
    }

    function ensureInitialRenderObserver() {
        if (initialRenderObserver || hasCompletedInitialRenderForCurrentSource.value || !viewerContainer.value) {
            return;
        }

        initialRenderObserver = new MutationObserver(() => {
            markInitialRenderCompleteIfReady();
        });
        initialRenderObserver.observe(viewerContainer.value, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
        });
    }

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
                stopInitialRenderObserver();
                return;
            }

            await nextTick();
            if (!markInitialRenderCompleteIfReady()) {
                ensureInitialRenderObserver();
            }
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
            stopInitialRenderObserver();
            return;
        }

        if (!markInitialRenderCompleteIfReady()) {
            ensureInitialRenderObserver();
        }
    });

    onScopeDispose(() => {
        stopInitialRenderObserver();
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
}
