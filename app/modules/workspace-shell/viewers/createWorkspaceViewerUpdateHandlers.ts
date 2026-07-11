import type { Ref } from 'vue';
import type { IAnalyticsDocumentScope } from '@app/composables/useAnalytics';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TPdfViewMode } from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browserLogger';
import { bucketPageCount } from '@app/utils/analytics';
import { emitAutomationEvent } from '@app/modules/workspace-shell/automation/automationReadinessEvents';

interface IWorkspaceViewerUpdateOptions {
    analytics: IAnalyticsDocumentScope;
    tabId: string;
    pdfSrc: Ref<TPdfSource | null>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<unknown>;
    isLoading: Ref<boolean>;
    continuousScroll: Ref<boolean>;
    fitMode: Ref<unknown>;
    viewMode: Ref<TPdfViewMode>;
    zoom: Ref<number>;
    viewerRef: Ref<IDocumentViewerExpose | null>;
    shouldAcceptPage: (page: number) => boolean;
}

export function createWorkspaceViewerUpdateHandlers(options: IWorkspaceViewerUpdateOptions) {
    function handleTotalPages(value: number) {
        if (value === 0 && Boolean(options.pdfSrc.value)) {
            return;
        }
        options.totalPages.value = value;
        if (value > 0) options.analytics.merge({
            pageCountBucket: bucketPageCount(value),
            totalPages: value,
        });
    }

    function handleCurrentPage(page: number) {
        const previousPage = options.currentPage.value;
        const viewer = options.viewerRef.value?.getViewerContainer?.() ?? null;
        const shared = {
            previousPage,
            sidebarOpen: options.showSidebar.value,
            sidebarTab: options.sidebarTab.value,
            totalPages: options.totalPages.value,
            isLoading: options.isLoading.value,
            continuousScroll: options.continuousScroll.value,
            fitMode: options.fitMode.value,
            viewMode: options.viewMode.value,
            zoom: options.zoom.value,
            viewerScrollTop: viewer ? Math.round(viewer.scrollTop) : null,
            viewerScrollLeft: viewer ? Math.round(viewer.scrollLeft) : null,
        };
        if (!options.shouldAcceptPage(page)) {
            BrowserLogger.diagnostic('pdf-nav', `[workspace-page-update] ignored stale viewer page ${previousPage}->${page}`, {
                ...shared,
                ignoredPage: page,
            });
            return;
        }
        BrowserLogger.diagnostic('pdf-nav', `[workspace-page-update] viewer->workspace ${previousPage}->${page}`, {
            ...shared,
            nextPage: page,
            changed: page !== previousPage,
        });
        options.currentPage.value = page;
        void nextTick().then(() => emitAutomationEvent('navigation-idle', {
            page,
            previousPage,
            tabId: options.tabId,
            totalPages: options.totalPages.value,
        }));
    }

    return {
        handleCurrentPage,
        handleTotalPages,
    };
}
