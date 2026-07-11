import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {
    PDFDocumentProxy,
    TPdfViewMode,
} from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';

interface IUsePdfViewerActivationRestoreOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    isActive: ComputedRef<boolean>;
    isLoading: Ref<boolean>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    viewMode: ComputedRef<TPdfViewMode>;
    getVisiblePageRange?: ((container: HTMLElement | null, numPages: number) => IPageRange) | undefined;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    scrollToPage: (pageNumber: number) => void;
    renderVisiblePages: (range: IPageRange, options?: {preserveRenderedPages?: boolean}) => Promise<void>;
    isPageRendered?: ((pageNumber: number) => boolean) | undefined;
    applySearchHighlights: () => void;
    // Retained only while callers shed the old transaction-controller argument.
    transactionController?: unknown;
}

/**
 * Activation is a single resume operation. Slot demand/rendering remains with
 * the normal renderer; this adapter neither polls the DOM nor starts recovery.
 */
export const usePdfViewerActivationRestore = (options: IUsePdfViewerActivationRestoreOptions) => {
    let activeRunId = 0;

    function nextActivationRestoreRunId() {
        return ++activeRunId;
    }

    function isActivationRunCurrent(runId: number) {
        return runId === activeRunId && options.isActive.value && !options.isLoading.value;
    }

    function currentRow(): IPageRange {
        const row = getPageRowBoundsForViewMode({
            pageNumber: options.currentPage.value,
            viewMode: options.viewMode.value,
            totalPages: Math.max(1, options.numPages.value),
        });
        return {
            start: row.start,
            end: row.end,
        };
    }

    async function renderActiveDocumentAfterActivation(runId: number) {
        const document = options.pdfDocument.value;
        if (!document || !options.viewerContainer.value || !isActivationRunCurrent(runId)) {
            return;
        }

        const measured = options.getVisiblePageRange?.(
            options.viewerContainer.value,
            options.numPages.value,
        );
        if (measured) {
            options.visibleRange.value = measured;
        } else {
            options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
        }

        const row = currentRow();
        if (options.currentPage.value < options.visibleRange.value.start
            || options.currentPage.value > options.visibleRange.value.end) {
            options.scrollToPage(options.currentPage.value);
        }
        await options.renderVisiblePages(row, {preserveRenderedPages: true});
        if (!isActivationRunCurrent(runId) || options.pdfDocument.value !== document) {
            return;
        }
        options.applySearchHighlights();
    }

    return {
        nextActivationRestoreRunId,
        isActivationRunCurrent,
        isActivationRestoreRunCurrent: (runId: number, document = options.pdfDocument.value) => (
            isActivationRunCurrent(runId) && document !== null && options.pdfDocument.value === document
        ),
        renderActiveDocumentAfterActivation,
    };
};
