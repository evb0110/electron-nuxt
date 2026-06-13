import type { MaybeRefOrGetter } from 'vue';
import { useTimeoutFn } from '@vueuse/core';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { WORKSPACE_PAGE_NAVIGATION_LOCK_MS } from '@app/modules/workspace-shell/workspacePageNavigationLockMs';

interface IUseWorkspaceToolbarPageModelOptions {
    sourcePage: MaybeRefOrGetter<number>;
    goToPage: (page: number) => void;
}

export function useWorkspaceToolbarPageModel(options: IUseWorkspaceToolbarPageModelOptions) {
    const optimisticPage = ref(toValue(options.sourcePage));
    let pendingNavigationPage: number | null = null;
    let pendingNavigationSourcePage: number | null = null;

    const {
        start: startPendingNavigationReconcileTimer,
        stop: stopPendingNavigationReconcileTimer,
    } = useTimeoutFn((page: number) => {
        if (pendingNavigationPage !== page) {
            return;
        }

        const sourcePage = toValue(options.sourcePage);
        logPdfRenderTrace('workspace-toolbar-page-pending-reconcile-timeout', {
            page,
            pendingNavigationPage,
            pendingNavigationSourcePage,
            sourcePage,
            timeoutMs: WORKSPACE_PAGE_NAVIGATION_LOCK_MS,
        });
        clearPendingNavigation('target-timeout');
        optimisticPage.value = sourcePage;
        logPdfRenderTrace('workspace-toolbar-page-source-sync', {
            page: sourcePage,
            reason: 'target-timeout',
        });
    }, WORKSPACE_PAGE_NAVIGATION_LOCK_MS, { immediate: false });

    watch(
        () => toValue(options.sourcePage),
        (page) => {
            if (pendingNavigationPage !== null) {
                if (page === pendingNavigationPage) {
                    logPdfRenderTrace('workspace-toolbar-page-source-caught-up', {
                        page,
                        pendingNavigationPage,
                        pendingNavigationSourcePage,
                    });
                    clearPendingNavigation('source-caught-up');
                    optimisticPage.value = page;
                    return;
                }

                logPdfRenderTrace('workspace-toolbar-page-source-ignored-pending-target', {
                    page,
                    pendingNavigationPage,
                    pendingNavigationSourcePage,
                });
                return;
            }

            optimisticPage.value = page;
            logPdfRenderTrace('workspace-toolbar-page-source-sync', { page });
        },
    );

    function commitNavigation(page: number) {
        logPdfRenderTrace('workspace-toolbar-page-commit-navigation', {
            page,
            sourcePage: toValue(options.sourcePage),
        });
        options.goToPage(page);
    }

    function clearPendingNavigation(reason: string) {
        if (pendingNavigationPage === null && pendingNavigationSourcePage === null) {
            clearPendingNavigationReconcileTimer();
            return;
        }

        clearPendingNavigationReconcileTimer();
        logPdfRenderTrace('workspace-toolbar-page-pending-cleared', {
            pendingNavigationPage,
            pendingNavigationSourcePage,
            reason,
            sourcePage: toValue(options.sourcePage),
        });
        pendingNavigationPage = null;
        pendingNavigationSourcePage = null;
    }

    function clearPendingNavigationReconcileTimer() {
        stopPendingNavigationReconcileTimer();
    }

    function schedulePendingNavigationReconcile(page: number) {
        clearPendingNavigationReconcileTimer();
        startPendingNavigationReconcileTimer(page);
    }

    onScopeDispose(() => {
        clearPendingNavigation('scope-dispose');
    });

    const currentPage = computed({
        get: () => optimisticPage.value,
        set: (page) => {
            optimisticPage.value = page;
        },
    });

    function handleGoToPage(page: number) {
        optimisticPage.value = page;
        if (pendingNavigationPage === null) {
            pendingNavigationSourcePage = toValue(options.sourcePage);
        }

        logPdfRenderTrace('workspace-toolbar-page-optimistic-set', {
            page,
            pendingNavigationPage,
            pendingNavigationSourcePage,
            sourcePage: toValue(options.sourcePage),
        });
        pendingNavigationPage = page;
        commitNavigation(page);
        if (page === toValue(options.sourcePage)) {
            clearPendingNavigation('already-at-target');
        } else {
            schedulePendingNavigationReconcile(page);
        }
    }

    return {
        currentPage,
        handleGoToPage,
    };
}
