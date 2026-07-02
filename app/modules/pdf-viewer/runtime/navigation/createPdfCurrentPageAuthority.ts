import type { Ref } from 'vue';
import type { createPdfNavigationRuntime } from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationRuntime';
import type { TPdfNavigationSource } from '@app/modules/pdf-viewer/runtime/navigation/navigationMachine';

type TPdfNavigationRuntime = ReturnType<typeof createPdfNavigationRuntime>;
type TPdfCurrentPageNavigationSource = Extract<TPdfNavigationSource, 'continuous' | 'paged' | 'search'>;

interface IPdfCurrentPageViewportCommitContext {
    previousPage?: number | undefined;
    source?: string | undefined;
}

interface IPdfCurrentPageAuthorityOptions {
    currentPage: Ref<number>;
    navigationRuntime: TPdfNavigationRuntime;
    numPages: Ref<number>;
    updateCurrentPage: (
        container: HTMLElement | null,
        numPages: number,
        options?: { requireAuthoritative?: boolean; } | undefined,
    ) => number;
}

export function createPdfCurrentPageAuthority(options: IPdfCurrentPageAuthorityOptions) {
    const {
        currentPage,
        navigationRuntime,
        numPages,
        updateCurrentPage,
    } = options;

    function canSyncFromViewport() {
        return navigationRuntime.canSyncCurrentPageFromViewport();
    }

    function commitViewportPage(
        page: number,
        context: IPdfCurrentPageViewportCommitContext = {},
    ) {
        return navigationRuntime.commitViewportCurrentPage(page, {
            previousPage: context.previousPage,
            source: context.source,
        });
    }

    function commitViewportPageFromSource(
        page: number,
        source: string,
        previousPage = currentPage.value,
    ) {
        return commitViewportPage(page, {
            previousPage,
            source,
        });
    }

    function commitActiveNavigationPage(
        targetPage: number,
        previousPage = currentPage.value,
    ) {
        const activeSource = navigationRuntime.source.value;
        if (!activeSource || navigationRuntime.status.value === 'idle') {
            return false;
        }
        return navigationRuntime.commitNavigationCurrentPage(
            activeSource,
            navigationRuntime.txn.value,
            targetPage,
            { previousPage },
        );
    }

    function commitNavigationPage(
        source: TPdfCurrentPageNavigationSource,
        runId: number,
        targetPage: number,
        previousPage = currentPage.value,
    ) {
        return navigationRuntime.commitNavigationCurrentPage(
            source,
            runId,
            targetPage,
            { previousPage },
        );
    }

    function syncFromViewportIfIdle(
        container: HTMLElement | null,
        source: string,
        syncOptions?: { requireAuthoritative?: boolean; } | undefined,
    ) {
        if (!canSyncFromViewport()) {
            return currentPage.value;
        }

        const previousPage = currentPage.value;
        const page = updateCurrentPage(container, numPages.value, syncOptions);
        commitViewportPage(page, {
            previousPage,
            source,
        });
        return page;
    }

    return {
        canSyncFromViewport,
        commitActiveNavigationPage,
        commitNavigationPage,
        commitViewportPage,
        commitViewportPageFromSource,
        syncFromViewportIfIdle,
    };
}
