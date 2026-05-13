import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/platformApi';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useWorkspaceSearchSidebar } from '@app/modules/workspace-shell/composables/useWorkspaceSearchSidebar';
import { useWorkspaceViewerShellState } from '@app/modules/workspace-shell/composables/useWorkspaceViewerShellState';

interface IWorkspaceSidebarSearchSyncControllerDeps {workingCopyPath: Ref<TDocumentRef | null>;}

export const useWorkspaceSidebarSearchSyncController = (
    deps: IWorkspaceSidebarSearchSyncControllerDeps,
) => {
    const {workingCopyPath} = deps;

    const viewerShellState = useWorkspaceViewerShellState();
    const {
        currentPage,
        totalPages,
        showSidebar,
        sidebarTab,
        isLoading,
        dragMode,
    } = viewerShellState;

    const searchSidebar = useWorkspaceSearchSidebar({
        workingCopyPath,
        showSidebar,
        sidebarTab,
        dragMode,
        totalPages,
    });

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
        ...viewerShellState,
        ...searchSidebar,
    };
};
