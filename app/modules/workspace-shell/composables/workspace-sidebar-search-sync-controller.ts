import type { Ref } from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    TFitMode,
    TZoomMode,
    TPdfViewMode,
} from '@contracts/shared';
import { useDropdownManager } from '@app/modules/workspace-shell/composables/useDropdownManager';
import { usePdfSearch } from '@app/composables/usePdfSearch';
import { usePageSearch } from '@app/modules/workspace-shell/composables/usePageSearch';
import { useSidebarResize } from '@app/modules/workspace-shell/composables/useSidebarResize';
import { BrowserLogger } from '@app/utils/browser-logger';
import type {
    IPdfViewerExpose,
    TPdfSidebarTab,
} from '@app/modules/workspace-shell/composables/workspace-orchestration.types';

interface IWorkspaceSidebarSearchSyncControllerDeps {workingCopyPath: Ref<string | null>;}

export const useWorkspaceSidebarSearchSyncController = (
    deps: IWorkspaceSidebarSearchSyncControllerDeps,
) => {
    const {workingCopyPath} = deps;

    const pdfViewerRef = ref<IPdfViewerExpose | null>(null);
    const zoomDropdownOpen = ref(false);
    const pageDropdownOpen = ref(false);
    const ocrPopupOpen = ref(false);
    const overflowMenuOpen = ref(false);

    const selectedThumbnailPages = ref<number[]>([]);
    const thumbnailInvalidationRequest = ref<{
        id: number;
        pages: number[];
    } | null>(null);
    let thumbnailInvalidationRequestId = 0;

    function setSelectedThumbnailPages(pages: number[]) {
        selectedThumbnailPages.value = [...pages];
    }

    function requestThumbnailInvalidation(pages: number[]) {
        thumbnailInvalidationRequestId += 1;
        thumbnailInvalidationRequest.value = {
            id: thumbnailInvalidationRequestId,
            pages: [...pages],
        };
    }

    function handleSelectedThumbnailPagesUpdate(pages: number[]) {
        setSelectedThumbnailPages(pages);
    }

    const {
        closeAllDropdowns,
        closeOtherDropdowns,
        handleDropdownOpenChange,
        openDropdown,
    } = useDropdownManager({
        zoomOpen: zoomDropdownOpen,
        pageOpen: pageDropdownOpen,
        ocrOpen: ocrPopupOpen,
        overflowOpen: overflowMenuOpen,
    });

    const zoom = ref(1);
    const effectiveZoom = ref(1);
    const zoomMode = ref<TZoomMode>('fit-width');
    const fitMode = ref<TFitMode>('width');
    const viewMode = ref<TPdfViewMode>('single');
    const currentPage = ref(1);
    const totalPages = ref(0);
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);

    const isLoading = ref(false);
    const dragMode = ref(true);
    const continuousScroll = ref(true);
    const showSidebar = ref(false);
    const showSettings = ref(false);
    const sidebarTab = ref<TPdfSidebarTab>('thumbnails');

    const {
        searchQuery,
        searchOptions,
        results,
        pageMatches,
        currentResultIndex,
        currentResult,
        isSearching,
        totalMatches,
        search,
        goToResult,
        setResultIndex,
        clearSearch,
        searchProgress,
        resetSearchCache,
        isTruncated,
        minQueryLength,
    } = usePdfSearch();

    const {
        openSearch,
        openAnnotations,
        closeSearch,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult: baseHandleGoToResult,
    } = usePageSearch({
        showSidebar,
        sidebarTab,
        dragMode,
        workingCopyPath,
        totalPages,
        searchQuery,
        searchOptions,
        search,
        goToResult,
        setResultIndex,
        clearSearch,
    });

    function handleGoToResult(index: number) {
        baseHandleGoToResult(index);
    }

    const {
        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        startSidebarResize,
        cleanupSidebarResizeListeners,
    } = useSidebarResize({ showSidebar });

    watch(currentPage, (next, previous) => {
        if (next === previous) {
            return;
        }
        BrowserLogger.warn('pdf-nav', `[workspace-sync-page] ${previous}->${next}`, {
            previous,
            next,
            showSidebar: showSidebar.value,
            sidebarTab: sidebarTab.value,
            totalPages: totalPages.value,
            isLoading: isLoading.value,
        });
    });

    watch(
        () => [
            showSidebar.value,
            sidebarTab.value,
            totalPages.value,
            isLoading.value,
        ] as const,
        ([
            nextShowSidebar,
            nextSidebarTab,
            nextTotalPages,
            nextLoading,
        ], [
            prevShowSidebar,
            prevSidebarTab,
            prevTotalPages,
            prevLoading,
        ]) => {
            if (
                nextShowSidebar === prevShowSidebar
                && nextSidebarTab === prevSidebarTab
                && nextTotalPages === prevTotalPages
                && nextLoading === prevLoading
            ) {
                return;
            }
            BrowserLogger.warn('pdf-nav', 'Workspace sync controller state changed', {
                showSidebar: {
                    previous: prevShowSidebar,
                    next: nextShowSidebar, 
                },
                sidebarTab: {
                    previous: prevSidebarTab,
                    next: nextSidebarTab, 
                },
                totalPages: {
                    previous: prevTotalPages,
                    next: nextTotalPages, 
                },
                isLoading: {
                    previous: prevLoading,
                    next: nextLoading, 
                },
                currentPage: currentPage.value,
            });
        },
    );

    return {
        pdfViewerRef,
        zoomDropdownOpen,
        pageDropdownOpen,
        ocrPopupOpen,
        overflowMenuOpen,
        closeAllDropdowns,
        closeOtherDropdowns,
        handleDropdownOpenChange,
        openDropdown,

        selectedThumbnailPages,
        thumbnailInvalidationRequest,
        setSelectedThumbnailPages,
        requestThumbnailInvalidation,
        handleSelectedThumbnailPagesUpdate,

        zoom,
        effectiveZoom,
        zoomMode,
        fitMode,
        viewMode,
        currentPage,
        totalPages,
        pdfDocument,

        isLoading,
        dragMode,
        continuousScroll,
        showSidebar,
        showSettings,
        sidebarTab,

        searchQuery,
        searchOptions,
        results,
        pageMatches,
        currentResultIndex,
        currentResult,
        isSearching,
        totalMatches,
        searchProgress,
        isTruncated,
        minQueryLength,

        openSearch,
        openAnnotations,
        closeSearch,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult,
        resetSearchCache,

        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        startSidebarResize,
        cleanupSidebarResizeListeners,
    };
};
