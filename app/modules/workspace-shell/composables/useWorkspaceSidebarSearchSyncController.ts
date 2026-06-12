import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useWorkspaceSearchSidebar } from '@app/modules/workspace-shell/composables/useWorkspaceSearchSidebar';
import { useWorkspaceViewerShellState } from '@app/modules/workspace-shell/composables/useWorkspaceViewerShellState';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

interface IWorkspaceSidebarSearchSyncControllerDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    initialViewState?: ITabViewSessionState | null;
}

type TWorkspaceSidebarSearchSnapshot = readonly [boolean, unknown, number, boolean];

export const useWorkspaceSidebarSearchSyncController = (
    deps: IWorkspaceSidebarSearchSyncControllerDeps,
) => {
    const {workingCopyPath} = deps;

    const viewerShellState = useWorkspaceViewerShellState(deps.initialViewState);
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

    watch(currentPage, (next: number, previous: number) => {
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
        (nextSnapshot: TWorkspaceSidebarSearchSnapshot, previousSnapshot: TWorkspaceSidebarSearchSnapshot) => {
            const nextShowSidebar = nextSnapshot[0];
            const nextSidebarTab = nextSnapshot[1];
            const nextTotalPages = nextSnapshot[2];
            const nextLoading = nextSnapshot[3];
            const prevShowSidebar = previousSnapshot[0];
            const prevSidebarTab = previousSnapshot[1];
            const prevTotalPages = previousSnapshot[2];
            const prevLoading = previousSnapshot[3];

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
