import type { MaybeRefOrGetter } from 'vue';
import { workspaceToolbarPageNavigationCommitDelayMs } from '@app/modules/workspace-shell/toolbar/workspaceToolbarPageNavigationCommitDelayMs';

interface IUseWorkspaceToolbarPageModelOptions {
    sourcePage: MaybeRefOrGetter<number>;
    updateCurrentPage: (page: number) => void;
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
                    clearPendingNavigation();
                    optimisticPage.value = page;
                    return;
                }

                if (
                    pendingNavigationSourcePage !== null
                    && page !== pendingNavigationSourcePage
                ) {
                    clearPendingNavigation();
                    optimisticPage.value = page;
                    return;
                }

                return;
            }

            optimisticPage.value = page;
        },
    );

    function commitNavigation(page: number) {
        options.goToPage(page);
        options.updateCurrentPage(page);
    }

    function clearNavigationBurstTimer() {
        if (navigationBurstTimer === null) {
            return;
        }
        clearTimeout(navigationBurstTimer);
        navigationBurstTimer = null;
    }

    function clearPendingNavigation() {
        clearNavigationBurstTimer();
        pendingNavigationPage = null;
        pendingNavigationSourcePage = null;
    }

    function scheduleNavigationBurstSettle() {
        clearNavigationBurstTimer();
        navigationBurstTimer = setTimeout(() => {
            navigationBurstTimer = null;
            const page = pendingNavigationPage;
            pendingNavigationPage = null;
            pendingNavigationSourcePage = null;
            if (page !== null) {
                commitNavigation(page);
                return;
            }
            optimisticPage.value = toValue(options.sourcePage);
        }, workspaceToolbarPageNavigationCommitDelayMs);
    }

    onScopeDispose(() => {
        clearPendingNavigation();
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

        pendingNavigationPage = page;
        scheduleNavigationBurstSettle();
    }

    return {
        currentPage,
        handleGoToPage,
    };
}
