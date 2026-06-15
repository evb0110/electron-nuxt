import type { MaybeRefOrGetter } from 'vue';
import { useTimeoutFn } from '@vueuse/core';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { WORKSPACE_PAGE_NAVIGATION_LOCK_MS } from '@app/modules/workspace-shell/workspacePageNavigationLockMs';

interface IUseWorkspaceToolbarPageModelOptions {
    sourcePage: MaybeRefOrGetter<number>;
    feedbackPage?: MaybeRefOrGetter<number | null | undefined>;
    goToPage: (page: number) => void;
}

export function useWorkspaceToolbarPageModel(options: IUseWorkspaceToolbarPageModelOptions) {
    const pendingNavigationPage = ref<number | null>(null);
    let pendingNavigationSourcePage: number | null = null;

    const {
        start: startPendingNavigationReconcileTimer,
        stop: stopPendingNavigationReconcileTimer,
    } = useTimeoutFn((page: number) => {
        if (pendingNavigationPage.value !== page) {
            return;
        }

        const sourcePage = toValue(options.sourcePage);
        logPdfRenderTrace('workspace-toolbar-page-pending-reconcile-timeout', {
            page,
            pendingNavigationPage: pendingNavigationPage.value,
            pendingNavigationSourcePage,
            sourcePage,
            timeoutMs: WORKSPACE_PAGE_NAVIGATION_LOCK_MS,
        });
        clearPendingNavigation('target-timeout');
    }, WORKSPACE_PAGE_NAVIGATION_LOCK_MS, { immediate: false });

    watch(
        () => toValue(options.sourcePage),
        (page) => {
            if (pendingNavigationPage.value !== null) {
                if (page === pendingNavigationPage.value) {
                    logPdfRenderTrace('workspace-toolbar-page-source-caught-up', {
                        page,
                        pendingNavigationPage: pendingNavigationPage.value,
                        pendingNavigationSourcePage,
                    });
                    clearPendingNavigation('source-caught-up');
                    return;
                }

                logPdfRenderTrace('workspace-toolbar-page-source-observed-pending-target', {
                    page,
                    pendingNavigationPage: pendingNavigationPage.value,
                    pendingNavigationSourcePage,
                });
                return;
            }

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
        if (pendingNavigationPage.value === null && pendingNavigationSourcePage === null) {
            clearPendingNavigationReconcileTimer();
            return;
        }

        clearPendingNavigationReconcileTimer();
        logPdfRenderTrace('workspace-toolbar-page-pending-cleared', {
            pendingNavigationPage: pendingNavigationPage.value,
            pendingNavigationSourcePage,
            reason,
            sourcePage: toValue(options.sourcePage),
        });
        pendingNavigationPage.value = null;
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

    const feedbackPage = computed(() => {
        const page = toValue(options.feedbackPage);
        return typeof page === 'number' && Number.isFinite(page)
            ? Math.max(1, Math.trunc(page))
            : null;
    });
    const currentPage = computed(() => feedbackPage.value ?? toValue(options.sourcePage));
    const navigationPage = computed(() => (
        pendingNavigationPage.value
        ?? feedbackPage.value
        ?? currentPage.value
    ));

    function handleGoToPage(page: number) {
        if (pendingNavigationPage.value === null) {
            pendingNavigationSourcePage = toValue(options.sourcePage);
        }

        logPdfRenderTrace('workspace-toolbar-page-navigation-target-set', {
            page,
            pendingNavigationPage: pendingNavigationPage.value,
            pendingNavigationSourcePage,
            sourcePage: toValue(options.sourcePage),
        });
        pendingNavigationPage.value = page;
        commitNavigation(page);
        if (page === toValue(options.sourcePage)) {
            clearPendingNavigation('already-at-target');
        } else {
            schedulePendingNavigationReconcile(page);
        }
    }

    return {
        currentPage,
        navigationPage,
        handleGoToPage,
    };
}
