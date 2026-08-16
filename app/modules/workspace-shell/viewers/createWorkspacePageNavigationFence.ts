import type { Ref } from 'vue';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

interface IWorkspacePageNavigationFenceOptions {
    currentPage: Ref<number>;
    openSurface?: IDocumentOpenSurfaceSession | undefined;
}

export function createWorkspacePageNavigationFence(options: IWorkspacePageNavigationFenceOptions) {
    const targetPage = ref<number | null>(null);

    function clear(reason = 'clear') {
        logPdfRenderTrace('workspace-programmatic-page-navigation-cleared', {
            reason,
            targetPage: targetPage.value,
        });
        targetPage.value = null;
    }

    function begin(page: number) {
        const previousTargetPage = targetPage.value;
        const viewport = options.openSurface?.viewportSession.value;
        if (
            viewport?.lifecycle === 'ready'
            && (viewport.observedPage ?? viewport.committedPage ?? viewport.requestedPage) === page
        ) {
            clear('navigation-already-settled');
            return;
        }
        targetPage.value = page;
        logPdfRenderTrace('workspace-programmatic-page-navigation-begin', {
            page,
            previousTargetPage,
            currentPage: options.currentPage.value,
        });
    }

    function settle(page: number) {
        logPdfRenderTrace('workspace-programmatic-page-navigation-settle', {
            page,
            targetPage: targetPage.value,
            currentPage: options.currentPage.value,
        });
        if (targetPage.value === page) {
            clear('target-settled');
        }
    }

    function shouldAcceptPage(page: number) {
        const pendingTargetPage = targetPage.value;
        if (pendingTargetPage === null) {
            logPdfRenderTrace('workspace-viewer-current-page-update-accepted', {
                page,
                targetPage: pendingTargetPage,
                currentPage: options.currentPage.value,
                reason: 'no-programmatic-target',
            });
            return true;
        }
        const viewport = options.openSurface?.viewportSession.value;
        if (
            viewport?.lifecycle === 'ready'
            && (viewport.observedPage ?? viewport.committedPage) === page
            && page !== pendingTargetPage
        ) {
            logPdfRenderTrace('workspace-viewer-current-page-update-accepted', {
                page,
                targetPage: pendingTargetPage,
                currentPage: options.currentPage.value,
                reason: 'navigation-superseded-by-surface',
            });
            clear('navigation-superseded-by-surface');
            return true;
        }
        if (page !== pendingTargetPage) {
            logPdfRenderTrace('workspace-viewer-current-page-update-rejected', {
                page,
                targetPage: pendingTargetPage,
                currentPage: options.currentPage.value,
                reason: 'target-pending',
            });
            return false;
        }
        logPdfRenderTrace('workspace-viewer-current-page-update-accepted', {
            page,
            targetPage: pendingTargetPage,
            currentPage: options.currentPage.value,
            reason: 'target-caught-up',
        });
        settle(page);
        return true;
    }

    function clampTo(availablePages: number) {
        const requestedPage = targetPage.value;
        if (requestedPage === null || availablePages <= 0) {
            return;
        }
        const clampedPage = Math.min(
            Math.max(1, Math.trunc(requestedPage)),
            Math.trunc(availablePages),
        );
        if (clampedPage === requestedPage) {
            return;
        }
        logPdfRenderTrace('workspace-programmatic-page-navigation-metadata-clamp', {
            requestedPage,
            clampedPage,
            pageCount: availablePages,
        });
        targetPage.value = clampedPage;
    }

    return {
        begin,
        clampTo,
        clear,
        shouldAcceptPage,
        targetPage: readonly(targetPage),
    };
}
