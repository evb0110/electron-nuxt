import type { MaybeRefOrGetter } from 'vue';
import { workspaceToolbarPageNavigationCommitDelayMs } from '@app/modules/workspace-shell/toolbar/workspaceToolbarPageNavigationCommitDelayMs';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

interface IUseWorkspaceToolbarPageModelOptions {
    sourcePage: MaybeRefOrGetter<number>;
    updateCurrentPage?: ((page: number) => void) | undefined;
    goToPage: (page: number) => void;
}

export function useWorkspaceToolbarPageModel(options: IUseWorkspaceToolbarPageModelOptions) {
    const optimisticPage = ref(toValue(options.sourcePage));
    let navigationBurstTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingNavigationPage: number | null = null;
    let pendingNavigationSourcePage: number | null = null;

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

                if (
                    pendingNavigationSourcePage !== null
                    && page !== pendingNavigationSourcePage
                ) {
                    logPdfRenderTrace('workspace-toolbar-page-source-diverged', {
                        page,
                        pendingNavigationPage,
                        pendingNavigationSourcePage,
                    });
                    clearPendingNavigation('source-diverged');
                    optimisticPage.value = page;
                    return;
                }

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

    function clearNavigationBurstTimer() {
        if (navigationBurstTimer === null) {
            return;
        }
        clearTimeout(navigationBurstTimer);
        navigationBurstTimer = null;
    }

    function clearPendingNavigation(reason: string) {
        clearNavigationBurstTimer();
        logPdfRenderTrace('workspace-toolbar-page-pending-cleared', {
            pendingNavigationPage,
            pendingNavigationSourcePage,
            reason,
            sourcePage: toValue(options.sourcePage),
        });
        pendingNavigationPage = null;
        pendingNavigationSourcePage = null;
    }

    function scheduleNavigationBurstSettle() {
        clearNavigationBurstTimer();
        logPdfRenderTrace('workspace-toolbar-page-debounce-scheduled', {
            delayMs: workspaceToolbarPageNavigationCommitDelayMs,
            pendingNavigationPage,
            pendingNavigationSourcePage,
            sourcePage: toValue(options.sourcePage),
        });
        navigationBurstTimer = setTimeout(() => {
            navigationBurstTimer = null;
            const page = pendingNavigationPage;
            pendingNavigationPage = null;
            pendingNavigationSourcePage = null;
            if (page !== null) {
                logPdfRenderTrace('workspace-toolbar-page-debounce-fired', {
                    page,
                    sourcePage: toValue(options.sourcePage),
                });
                commitNavigation(page);
                return;
            }
            logPdfRenderTrace('workspace-toolbar-page-debounce-fired-empty', { sourcePage: toValue(options.sourcePage) });
            optimisticPage.value = toValue(options.sourcePage);
        }, workspaceToolbarPageNavigationCommitDelayMs);
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
        scheduleNavigationBurstSettle();
    }

    return {
        currentPage,
        handleGoToPage,
    };
}
