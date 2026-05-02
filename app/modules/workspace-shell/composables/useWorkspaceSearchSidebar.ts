import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/platform-api';
import { usePdfSearch } from '@app/composables/usePdfSearch';
import { usePageSearch } from '@app/modules/workspace-shell/composables/usePageSearch';
import { useSidebarResize } from '@app/modules/workspace-shell/composables/useSidebarResize';
import type { TPdfSidebarTab } from '@app/modules/workspace-shell/composables/workspace-orchestration.types';

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
        searchOptions,
        results,
        pageMatches,
        currentResultIndex,
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
        searchOptions,
        results,
        pageMatches,
        currentResultIndex,
        currentResult,
        isSearching,
        searchError,
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
