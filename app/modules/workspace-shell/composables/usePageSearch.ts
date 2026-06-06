import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/platformApi';
import type { IPdfSearchRequestOptions } from '@contracts/search';
import type { TPdfSidebarTab } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';

interface IPageSearchDeps {
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    dragMode: Ref<boolean>;
    workingCopyPath: Ref<TDocumentRef | null>;
    totalPages: Ref<number>;
    searchQuery: Ref<string>;
    searchOptions: Ref<Required<Pick<IPdfSearchRequestOptions, 'matchCase' | 'wholeWord' | 'useRegex'>>>;
    search: (
        query: string,
        path: TDocumentRef,
        totalPages?: number,
        options?: Partial<Pick<IPdfSearchRequestOptions, 'matchCase' | 'wholeWord' | 'useRegex'>>,
    ) => Promise<boolean>;
    goToResult: (direction: 'next' | 'previous') => void;
    setResultIndex: (index: number) => void;
    clearSearch: () => void;
}

export const usePageSearch = (deps: IPageSearchDeps) => {
    const {
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
    } = deps;

    const searchFocusRequest = ref(0);

    function openSearch() {
        showSidebar.value = true;
        sidebarTab.value = 'search';
        searchFocusRequest.value += 1;
    }

    function openAnnotations() {
        if (showSidebar.value && sidebarTab.value === 'annotations') {
            showSidebar.value = false;
            return;
        }
        showSidebar.value = true;
        sidebarTab.value = 'annotations';
        dragMode.value = false;
    }

    function closeSearch() {
        clearSearch();
        sidebarTab.value = 'thumbnails';
    }

    watch(workingCopyPath, () => {
        clearSearch();
    });

    async function handleSearch() {
        if (workingCopyPath.value) {
            showSidebar.value = true;
            sidebarTab.value = 'search';
            await search(
                searchQuery.value,
                workingCopyPath.value,
                totalPages.value > 0 ? totalPages.value : undefined,
                searchOptions.value,
            );
        }
    }

    function handleSearchNext() {
        goToResult('next');
    }

    function handleSearchPrevious() {
        goToResult('previous');
    }

    function handleGoToResult(index: number) {
        setResultIndex(index);
    }

    return {
        openSearch,
        searchFocusRequest,
        openAnnotations,
        closeSearch,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult,
    };
};
