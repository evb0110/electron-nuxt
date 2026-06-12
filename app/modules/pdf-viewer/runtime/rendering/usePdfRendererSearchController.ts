import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdf';
import { createPdfSearchMatchScroller } from '@app/modules/pdf-viewer/engine/pdf-search-match-scroller/createPdfSearchMatchScroller';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfNav } from '@app/utils/logPdfNav';

interface IUsePdfRendererSearchControllerOptions {
    container: Ref<HTMLElement | null>;
    isActive: MaybeRefOrGetter<boolean>;
    isLoading: Ref<boolean>;
    numPages: Ref<number>;
    textLayerRenderer: ReturnType<typeof usePdfTextLayerRenderer>;
    searchPageMatches: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch: MaybeRefOrGetter<IPdfSearchMatch | null>;
    currentSearchMatchNavigationId: MaybeRefOrGetter<number>;
    scheduleRenderForSinglePage: (pageNumber: number) => void;
    scrollToPage?: (
        pageNumber: number,
        options?: IScrollToPageOptions,
    ) => void;
    suppressSnap?: () => void;
    beginSearchNavigation?: (pageNumber: number) => void;
    endSearchNavigation?: (settleMs?: number) => void;
}

export function usePdfRendererSearchController(options: IUsePdfRendererSearchControllerOptions) {
    const {
        container,
        isActive,
        isLoading,
        numPages,
        textLayerRenderer,
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId,
        scheduleRenderForSinglePage,
    } = options;

    function applySearchHighlights() {
        const containerRoot = container.value;
        if (!containerRoot) {
            return;
        }
        try {
            textLayerRenderer.applyAllSearchHighlights(containerRoot);
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to apply search highlights',
                error,
            );
        }
    }

    function scrollToCurrentMatch() {
        const containerRoot = container.value;
        if (!containerRoot) {
            return false;
        }

        let result = false;
        try {
            result = textLayerRenderer.scrollToCurrentMatch(containerRoot);
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to scroll to current match',
                error,
            );
            return false;
        }
        logPdfNav(`[PDF-NAV] scrollToCurrentMatch result=${result}`);
        if (result) {
            options.suppressSnap?.();
        }
        return result;
    }

    const searchMatchScroller = createPdfSearchMatchScroller({
        getContainer: () => container.value,
        getCurrentSearchMatch: () => toValue(currentSearchMatch),
        scrollToCurrentMatch,
        scheduleRenderForSinglePage,
        ...(options.scrollToPage ? { scrollToPage: options.scrollToPage } : {}),
        ...(options.suppressSnap ? { suppressSnap: options.suppressSnap } : {}),
        ...(options.beginSearchNavigation ? { beginSearchNavigation: options.beginSearchNavigation } : {}),
        ...(options.endSearchNavigation ? { endSearchNavigation: options.endSearchNavigation } : {}),
    });

    let lastHandledSearchNavigationId = 0;

    watch(
        () => {
            const match = toValue(currentSearchMatch);
            return [
                isLoading.value,
                toValue(searchPageMatches),
                match?.pageIndex ?? -1,
                match?.matchIndex ?? -1,
                match?.startOffset ?? -1,
                match?.endOffset ?? -1,
            ] as const;
        },
        () => {
            if (!toValue(isActive)) {
                return;
            }
            if (isLoading.value) {
                return;
            }

            applySearchHighlights();
        },
    );

    watch(
        () => [
            toValue(isActive),
            isLoading.value,
            toValue(currentSearchMatchNavigationId),
        ] as const,
        ([
            active,
            loading,
            navigationId,
        ]) => {
            if (!active) {
                return;
            }
            if (navigationId <= 0 || navigationId === lastHandledSearchNavigationId) {
                return;
            }
            if (loading) {
                return;
            }

            const currentMatchValue = toValue(currentSearchMatch);
            const matchPageIndex = currentMatchValue && numPages.value > 0
                ? clamp(currentMatchValue.pageIndex, 0, numPages.value - 1)
                : null;

            if (matchPageIndex === null) {
                searchMatchScroller.invalidatePendingRequests();
                lastHandledSearchNavigationId = navigationId;
                return;
            }

            logPdfNav(`[PDF-NAV] navigation watcher: requestScrollToMatch(${matchPageIndex})`);
            lastHandledSearchNavigationId = navigationId;
            searchMatchScroller.requestScrollToMatch(matchPageIndex);
        },
    );

    function requestScrollToCurrentResult() {
        if (!toValue(isActive)) {
            return;
        }
        const currentMatchValue = toValue(currentSearchMatch);
        if (!currentMatchValue) {
            return;
        }
        searchMatchScroller.requestScrollToMatch(currentMatchValue.pageIndex);
    }

    return {
        applySearchHighlights,
        requestScrollToCurrentResult,
        invalidatePendingRequests: searchMatchScroller.invalidatePendingRequests,
    };
}
