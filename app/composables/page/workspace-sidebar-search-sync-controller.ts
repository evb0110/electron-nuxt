import {
    ref,
    shallowRef,
    type Ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    TFitMode,
    TPdfViewMode,
} from '@app/types/shared';
import { useDropdownManager } from '@app/composables/useDropdownManager';
import { usePdfSearch } from '@app/composables/usePdfSearch';
import { usePageSearch } from '@app/composables/usePageSearch';
import { useSidebarResize } from '@app/composables/useSidebarResize';
import type {
    IPdfViewerExpose,
    TPdfSidebarTab,
} from '@app/composables/page/workspace-orchestration.types';

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
