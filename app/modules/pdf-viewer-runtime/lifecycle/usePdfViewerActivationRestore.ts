import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {
    PDFDocumentProxy,
    TPdfViewMode,
} from '@app/types/pdf';
import { getPageRowBoundsForViewMode } from '@app/composables/pdf/pdfPageLayout';

interface IPageRange {
    start: number;
    end: number;
}

interface IUsePdfViewerActivationRestoreOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    isActive: ComputedRef<boolean>;
    isLoading: Ref<boolean>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    viewMode: ComputedRef<TPdfViewMode>;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    scrollToPage: (pageNumber: number) => void;
    renderVisiblePages: (
        range: IPageRange,
        options?: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
            forceRerender?: boolean;
        },
    ) => Promise<void>;
    isPageRendered: (page: number) => boolean;
    applySearchHighlights: () => void;
}

export function usePdfViewerActivationRestore(options: IUsePdfViewerActivationRestoreOptions) {
    const {
        viewerContainer,
        pdfDocument,
        isActive,
        isLoading,
        numPages,
        currentPage,
        visibleRange,
        viewMode,
        updateVisibleRange,
        scrollToPage,
        renderVisiblePages,
        isPageRendered,
        applySearchHighlights,
    } = options;
    let activeDocumentRestoreRunId = 0;

    function nextActivationRestoreRunId() {
        activeDocumentRestoreRunId += 1;
        return activeDocumentRestoreRunId;
    }

    function getCurrentPageRowRange(): IPageRange {
        if (numPages.value <= 0) {
            return {
                start: 1,
                end: 1,
            };
        }

        const rowBounds = getPageRowBoundsForViewMode({
            pageNumber: currentPage.value,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
        return {
            start: rowBounds.start,
            end: rowBounds.end,
        };
    }

    function rangeContainsPage(range: IPageRange, page: number) {
        return page >= range.start && page <= range.end;
    }

    function hasMountedPageCanvas(pageNumber: number) {
        return Boolean(
            viewerContainer.value?.querySelector(
                `.page_container[data-page="${pageNumber}"] .page_canvas canvas`,
            ),
        );
    }

    function hasRenderedContentInRange(range: IPageRange) {
        if (!viewerContainer.value) {
            return true;
        }

        for (let page = range.start; page <= range.end; page += 1) {
            if (isPageRendered(page) || hasMountedPageCanvas(page)) {
                return true;
            }
        }

        return false;
    }

    function isActiveDocumentRestoreRunCurrent(runId: number) {
        return runId === activeDocumentRestoreRunId
            && isActive.value
            && !isLoading.value
            && Boolean(pdfDocument.value);
    }

    async function waitForActivationRenderFrame() {
        await nextTick();
        await new Promise<void>((resolve) => {
            if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(() => resolve());
                return;
            }
            setTimeout(resolve, 0);
        });
    }

    async function restoreCurrentPageViewportForActivation() {
        updateVisibleRange(viewerContainer.value, numPages.value);
        const visible = visibleRange.value;
        if (
            !viewerContainer.value
            || numPages.value <= 0
            || rangeContainsPage(visible, currentPage.value)
        ) {
            return;
        }

        scrollToPage(currentPage.value);
        await waitForActivationRenderFrame();
        updateVisibleRange(viewerContainer.value, numPages.value);
    }

    async function renderActiveDocumentAfterActivation(runId: number) {
        await restoreCurrentPageViewportForActivation();
        if (!isActiveDocumentRestoreRunCurrent(runId)) {
            return;
        }

        const activationRange = { ...visibleRange.value };
        await renderVisiblePages(activationRange, { preserveRenderedPages: true });
        if (!isActiveDocumentRestoreRunCurrent(runId)) {
            return;
        }

        const currentRow = getCurrentPageRowRange();
        if (hasRenderedContentInRange(currentRow)) {
            applySearchHighlights();
            return;
        }

        if (!rangeContainsPage(visibleRange.value, currentPage.value)) {
            scrollToPage(currentPage.value);
            await waitForActivationRenderFrame();
            updateVisibleRange(viewerContainer.value, numPages.value);
            if (!isActiveDocumentRestoreRunCurrent(runId)) {
                return;
            }
        }

        await renderVisiblePages(currentRow, {
            preserveRenderedPages: true,
            forceRerender: true,
            bufferOverride: 0,
        });
        if (!isActiveDocumentRestoreRunCurrent(runId)) {
            return;
        }
        applySearchHighlights();
    }

    return {
        nextActivationRestoreRunId,
        isActivationRestoreRunCurrent: isActiveDocumentRestoreRunCurrent,
        renderActiveDocumentAfterActivation,
    };
}
