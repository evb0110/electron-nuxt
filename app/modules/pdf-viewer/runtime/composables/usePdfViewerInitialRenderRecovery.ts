import type { Ref } from 'vue';
import { delay } from 'es-toolkit/promise';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';

const INITIAL_CONTENT_SHORT_WAIT_MS = 40;
const INITIAL_CONTENT_LONG_WAIT_MS = 80;

interface IUsePdfViewerInitialRenderRecoveryOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    isLoading: Ref<boolean>;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    reRenderVisiblePagesAndSyncCurrentPage: () => Promise<void>;
    renderVisiblePages: (range: IPageRange) => Promise<void>;
    getVisibleRange: () => IPageRange;
    syncCurrentPageFromViewport: (options?: {
        source?: string;
        stabilize?: boolean 
    }) => Promise<void>;
}

export const usePdfViewerInitialRenderRecovery = (options: IUsePdfViewerInitialRenderRecoveryOptions) => {
    function hasRenderedPageCanvas() {
        const container = options.viewerContainer.value;
        if (!container) {
            return false;
        }
        return Boolean(
            container.querySelector('.page_container .page_canvas canvas'),
        );
    }

    function hasRenderedInitialContent() {
        return hasRenderedPageCanvas();
    }

    function refreshVisibleRangeForRecovery() {
        options.computeFitWidthScale(options.viewerContainer.value);
        options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
    }

    function logAsyncStageError(stage: string, error: unknown) {
        BrowserLogger.error('pdf-viewer', `Failed to ${stage}`, error);
    }

    async function recoverInitialRenderIfNeeded() {
        if (!options.pdfDocument.value || options.isLoading.value || options.numPages.value <= 0) {
            return;
        }
        if (hasRenderedInitialContent()) {
            return;
        }
        await nextTick();
        await delay(INITIAL_CONTENT_SHORT_WAIT_MS);
        if (hasRenderedInitialContent()) {
            return;
        }

        refreshVisibleRangeForRecovery();
        try {
            await options.reRenderVisiblePagesAndSyncCurrentPage();
        } catch (error) {
            logAsyncStageError(
                're-render visible pages during initial recovery',
                error,
            );
        }

        await nextTick();
        await delay(INITIAL_CONTENT_LONG_WAIT_MS);
        if (hasRenderedInitialContent()) {
            return;
        }

        refreshVisibleRangeForRecovery();
        try {
            await options.renderVisiblePages(options.getVisibleRange());
            await options.syncCurrentPageFromViewport({ source: 'recover-initial-render' });
        } catch (error) {
            logAsyncStageError('render visible pages during initial recovery', error);
        }
    }

    function scheduleRecoverInitialRender() {
        runGuardedTask(() => recoverInitialRenderIfNeeded(), {
            category: 'user-visible-operation',
            scope: 'pdf-viewer',
            message: 'Failed to recover initial PDF render',
        });
    }

    return { scheduleRecoverInitialRender };
};
