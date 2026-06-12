import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import type {
    IPageRange,
    PDFDocumentProxy,
    TPdfViewMode,
} from '@app/types/pdf';
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

const ACTIVATION_RESTORE_CONTAINER_FRAME_LIMIT = 30;

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
            return false;
        }

        for (let page = range.start; page <= range.end; page += 1) {
            if (isPageRendered(page) || hasMountedPageCanvas(page)) {
                return true;
            }
        }

        return false;
    }

    function isActiveDocumentRestoreRunCurrent(runId: number) {
        return isActivationRunCurrent(runId)
            && Boolean(pdfDocument.value);
    }

    function isActivationRunCurrent(runId: number) {
        return runId === activeDocumentRestoreRunId
            && isActive.value
            && !isLoading.value;
    }

    async function waitForActivationRenderFrame() {
        await nextTick();
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            await new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => resolve());
            });
            return;
        }
        await delay(0);
    }

    function hasMeasurableViewerContainer() {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }

        const rect = container.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    async function waitForActivationViewerContainer(runId: number) {
        for (let frame = 0; frame < ACTIVATION_RESTORE_CONTAINER_FRAME_LIMIT; frame += 1) {
            if (!isActivationRunCurrent(runId)) {
                return false;
            }
            if (hasMeasurableViewerContainer()) {
                return true;
            }
            await waitForActivationRenderFrame();
        }

        return isActivationRunCurrent(runId) && hasMeasurableViewerContainer();
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
        if (!await waitForActivationViewerContainer(runId)) {
            return;
        }
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
        isActivationRunCurrent,
        isActivationRestoreRunCurrent: isActiveDocumentRestoreRunCurrent,
        renderActiveDocumentAfterActivation,
    };
}
