import type { MaybeRefOrGetter } from 'vue';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

interface IUseWorkspaceToolbarPageModelOptions {
    sourcePage: MaybeRefOrGetter<number>;
    feedbackPage?: MaybeRefOrGetter<number | null | undefined>;
    authoritativeCommand?: MaybeRefOrGetter<{
        page: number;
        revision: number;
    } | null | undefined>;
    sessionActive?: MaybeRefOrGetter<boolean>;
    goToPage: (page: number) => void;
}

export const useWorkspaceToolbarPageModel = (options: IUseWorkspaceToolbarPageModelOptions) => {
    const pendingNavigationPage = ref<number | null>(null);
    let pendingNavigationSourcePage: number | null = null;

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

    if (options.sessionActive !== undefined) {
        watch(
            () => toValue(options.sessionActive),
            (active) => {
                if (!active) {
                    clearPendingNavigation('session-ended');
                }
            },
            { flush: 'sync' },
        );
    }

    if (options.authoritativeCommand !== undefined) {
        watch(
            () => toValue(options.authoritativeCommand),
            (command) => {
                if (
                    command
                    && pendingNavigationPage.value !== null
                    && command.page !== pendingNavigationPage.value
                ) clearPendingNavigation('authoritative-command-superseded');
            },
            {flush: 'sync'},
        );
    }

    function commitNavigation(page: number) {
        logPdfRenderTrace('workspace-toolbar-page-commit-navigation', {
            page,
            sourcePage: toValue(options.sourcePage),
        });
        options.goToPage(page);
    }

    function clearPendingNavigation(reason: string) {
        if (pendingNavigationPage.value === null && pendingNavigationSourcePage === null) {
            return;
        }

        logPdfRenderTrace('workspace-toolbar-page-pending-cleared', {
            pendingNavigationPage: pendingNavigationPage.value,
            pendingNavigationSourcePage,
            reason,
            sourcePage: toValue(options.sourcePage),
        });
        pendingNavigationPage.value = null;
        pendingNavigationSourcePage = null;
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
    // Feedback is the command cursor used to compose rapid Next/Previous
    // requests. It is not a presentation commit: displaying it as the current
    // page lets the toolbar outrun the live viewport while a far target is
    // still mounting or rendering.
    const currentPage = computed(() => toValue(options.sourcePage));
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
        }
    }

    return {
        currentPage,
        navigationPage,
        handleGoToPage,
        cancelPendingNavigation: () => clearPendingNavigation('explicit-cancel'),
    };
};
