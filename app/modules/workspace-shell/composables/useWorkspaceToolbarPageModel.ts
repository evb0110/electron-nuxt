import type { MaybeRefOrGetter } from 'vue';

interface IUseWorkspaceToolbarPageModelOptions {
    sourcePage: MaybeRefOrGetter<number>;
    updateCurrentPage: (page: number) => void;
    goToPage: (page: number) => void;
}

export const WORKSPACE_TOOLBAR_PAGE_NAVIGATION_COMMIT_DELAY_MS = 80;

export function useWorkspaceToolbarPageModel(options: IUseWorkspaceToolbarPageModelOptions) {
    const optimisticPage = ref(toValue(options.sourcePage));
    let navigationBurstTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingNavigationPage: number | null = null;

    watch(
        () => toValue(options.sourcePage),
        (page) => {
            if (navigationBurstTimer !== null || pendingNavigationPage !== null) {
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

    function scheduleNavigationBurstSettle() {
        clearNavigationBurstTimer();
        navigationBurstTimer = setTimeout(() => {
            navigationBurstTimer = null;
            const page = pendingNavigationPage;
            pendingNavigationPage = null;
            if (page !== null) {
                commitNavigation(page);
                return;
            }
            optimisticPage.value = toValue(options.sourcePage);
        }, WORKSPACE_TOOLBAR_PAGE_NAVIGATION_COMMIT_DELAY_MS);
    }

    onScopeDispose(() => {
        clearNavigationBurstTimer();
        pendingNavigationPage = null;
    });

    const currentPage = computed({
        get: () => optimisticPage.value,
        set: (page: number) => {
            optimisticPage.value = page;
        },
    });

    function handleGoToPage(page: number) {
        optimisticPage.value = page;
        if (navigationBurstTimer === null && pendingNavigationPage === null) {
            commitNavigation(page);
            scheduleNavigationBurstSettle();
            return;
        }

        pendingNavigationPage = page;
        scheduleNavigationBurstSettle();
    }

    return {
        currentPage,
        handleGoToPage,
    };
}
