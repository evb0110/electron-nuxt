import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/platformApi';
import { usePdfSearch } from '@app/composables/usePdfSearch';
import { usePageSearch } from '@app/modules/workspace-shell/composables/usePageSearch';
import { useSidebarResize } from '@app/modules/workspace-shell/composables/useSidebarResize';
import type { TPdfSidebarTab } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';

interface IWorkspaceSearchSidebarOptions {
    workingCopyPath: Ref<TDocumentRef | null>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    dragMode: Ref<boolean>;
    totalPages: Ref<number>;
}

export const useWorkspaceSearchSidebar = (options: IWorkspaceSearchSidebarOptions) => {
    const {
        workingCopyPath,
        showSidebar,
        sidebarTab,
        dragMode,
        totalPages,
    } = options;

    const {
        searchQuery,
        submittedSearchQuery,
        searchOptions,
        results,
        pageMatches,
        currentResultIndex,
        currentResultNavigationId,
        currentResult,
        isSearching,
        searchError,
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
        searchFocusRequest,
        openAnnotations,
        closeSearch,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult,
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

    const {
        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        startSidebarResize,
        cleanupSidebarResizeListeners,
    } = useSidebarResize({ showSidebar });

    return {
        searchQuery,
        submittedSearchQuery,
        searchOptions,
        results,
        pageMatches,
        currentResultIndex,
        currentResultNavigationId,
        currentResult,
        isSearching,
        searchError,
        totalMatches,
        searchProgress,
        isTruncated,
        minQueryLength,
        openSearch,
        searchFocusRequest,
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
