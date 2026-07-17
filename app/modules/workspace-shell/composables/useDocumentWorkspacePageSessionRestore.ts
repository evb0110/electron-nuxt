import type { Ref } from 'vue';

interface IDocumentWorkspacePageSessionRestoreOptions {
    activeViewerAdapter: Readonly<Ref<unknown>>;
    currentPage: Ref<number>;
    documentViewerRef: Readonly<Ref<unknown>>;
    initialPage: number | undefined;
    isLoading: Ref<boolean>;
    onRestore: (pageNumber: number) => void;
    totalPages: Ref<number>;
}

export const useDocumentWorkspacePageSessionRestore = (
    options: IDocumentWorkspacePageSessionRestoreOptions,
) => {
    // A hibernated tab remounts its viewer and reopens the source. Source setup
    // may publish page 1 before metadata is available; preserve the persisted
    // navigation intent until a live renderer and authoritative count exist.
    let pendingInitialPageRestore = options.initialPage == null
        ? null
        : Math.max(1, Math.trunc(options.initialPage));
    watch(options.activeViewerAdapter, (adapter) => {
        if (!adapter) {
            options.currentPage.value = 1;
            options.totalPages.value = 0;
            options.isLoading.value = false;
        }
    });
    watch([
        options.activeViewerAdapter,
        options.totalPages,
        options.documentViewerRef,
    ], ([
        adapter,
        pageCount,
        viewer,
    ]) => {
        if (pendingInitialPageRestore === null || !adapter || !viewer || pageCount <= 0) {
            return;
        }
        const targetPage = Math.min(pendingInitialPageRestore, pageCount);
        pendingInitialPageRestore = null;
        options.onRestore(targetPage);
    }, {flush: 'post'});
};
