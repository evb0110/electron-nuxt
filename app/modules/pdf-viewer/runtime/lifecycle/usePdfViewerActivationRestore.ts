import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import type {
    PDFDocumentProxy,
    TPdfViewMode,
} from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import type {
    IPdfViewerTransactionCancellation,
    TPdfViewerTransactionState,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';

type TActivationRestoreAdvanceState = Exclude<
    TPdfViewerTransactionState,
    'preparing' | 'cancelled'
>;

interface IActivationRestoreTransactionController {
    beginTransaction: (options: {
        kind: 'recovery';
        source: 'activation-restore';
        page: number;
        range: IPageRange;
        anchor: 'top';
    }) => { id: number } | null;
    advanceTransaction: (
        transactionId: number,
        state: TActivationRestoreAdvanceState,
    ) => boolean;
    cancelActiveTransaction: (
        cancellation: IPdfViewerTransactionCancellation,
        transactionId?: number,
    ) => boolean;
    isTransactionCurrent: (transactionId: number) => boolean;
    commitVisibleRange: (
        range: IPageRange,
        options?: { transactionId?: number | undefined },
    ) => boolean;
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
    getVisiblePageRange?: ((container: HTMLElement | null, numPages: number) => IPageRange) | undefined;
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
    transactionController?: IActivationRestoreTransactionController | undefined;
}

const ACTIVATION_RESTORE_CONTAINER_FRAME_LIMIT = 30;

export const usePdfViewerActivationRestore = (options: IUsePdfViewerActivationRestoreOptions) => {
    const {
        viewerContainer,
        pdfDocument,
        isActive,
        isLoading,
        numPages,
        currentPage,
        visibleRange,
        viewMode,
        getVisiblePageRange,
        updateVisibleRange,
        scrollToPage,
        renderVisiblePages,
        isPageRendered,
        applySearchHighlights,
        transactionController,
    } = options;
    let activeDocumentRestoreRunId = 0;
    let activeActivationTransactionId: number | null = null;

    function createActivationCancellation(
        reason: IPdfViewerTransactionCancellation['reason'],
    ): IPdfViewerTransactionCancellation {
        return {
            reason,
            cancelInFlightRenders: false,
            bumpRenderVersion: false,
            clearTimers: true,
            preserveVisualContent: true,
        };
    }

    function cancelActivationTransaction(
        transactionId: number | null,
        reason: IPdfViewerTransactionCancellation['reason'],
    ) {
        if (transactionId === null) {
            return true;
        }
        if (
            transactionController
            && !transactionController.isTransactionCurrent(transactionId)
        ) {
            if (activeActivationTransactionId === transactionId) {
                activeActivationTransactionId = null;
            }
            return true;
        }
        const didCancel = transactionController?.cancelActiveTransaction(
            createActivationCancellation(reason),
            transactionId,
        ) ?? true;
        if (activeActivationTransactionId === transactionId) {
            activeActivationTransactionId = null;
        }
        return didCancel;
    }

    function nextActivationRestoreRunId() {
        cancelActivationTransaction(activeActivationTransactionId, 'superseded');
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

    function hasRenderedContentForPage(pageNumber: number) {
        if (!viewerContainer.value) {
            return false;
        }

        return isPageRendered(pageNumber) || hasMountedPageCanvas(pageNumber);
    }

    function hasRenderedContentForEveryPageInRange(range: IPageRange) {
        if (!viewerContainer.value) {
            return false;
        }

        for (let page = range.start; page <= range.end; page += 1) {
            if (!hasRenderedContentForPage(page)) {
                return false;
            }
        }

        return true;
    }

    function isActiveDocumentRestoreRunCurrent(
        runId: number,
        document: PDFDocumentProxy | null = pdfDocument.value,
    ) {
        return isActivationRunCurrent(runId)
            && Boolean(document)
            && pdfDocument.value === document;
    }

    function isActivationRunCurrent(runId: number) {
        return runId === activeDocumentRestoreRunId
            && isActive.value
            && !isLoading.value;
    }

    function beginActivationTransaction() {
        const range = getCurrentPageRowRange();
        const transaction = transactionController?.beginTransaction({
            kind: 'recovery',
            source: 'activation-restore',
            page: currentPage.value,
            range,
            anchor: 'top',
        });
        if (transactionController && !transaction) {
            return null;
        }
        activeActivationTransactionId = transaction?.id ?? null;
        return activeActivationTransactionId;
    }

    function isActivationTransactionCurrent(transactionId: number | null) {
        return transactionId === null
            || transactionController?.isTransactionCurrent(transactionId) !== false;
    }

    function advanceActivationTransaction(
        transactionId: number | null,
        state: TActivationRestoreAdvanceState,
    ) {
        if (transactionId === null) {
            return true;
        }
        return transactionController?.advanceTransaction(transactionId, state) ?? true;
    }

    function settleActivationTransaction(transactionId: number | null) {
        if (transactionId === null) {
            return true;
        }
        const didSettle = transactionController?.advanceTransaction(transactionId, 'settled') ?? true;
        if (activeActivationTransactionId === transactionId) {
            activeActivationTransactionId = null;
        }
        return didSettle;
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

    function commitActivationVisibleRange(transactionId: number | null) {
        const range = getVisiblePageRange?.(viewerContainer.value, numPages.value);
        if (range) {
            const didCommit = transactionController?.commitVisibleRange(
                range,
                transactionId !== null ? { transactionId } : undefined,
            );
            if (didCommit !== undefined) {
                return didCommit;
            }
            visibleRange.value = range;
            return true;
        }
        if (!isActivationTransactionCurrent(transactionId)) {
            return false;
        }
        updateVisibleRange(viewerContainer.value, numPages.value);
        return true;
    }

    async function restoreCurrentPageViewportForActivation(transactionId: number | null) {
        if (!commitActivationVisibleRange(transactionId)) {
            return false;
        }
        const visible = visibleRange.value;
        if (
            !viewerContainer.value
            || numPages.value <= 0
            || rangeContainsPage(visible, currentPage.value)
        ) {
            return true;
        }

        scrollToPage(currentPage.value);
        await waitForActivationRenderFrame();
        return commitActivationVisibleRange(transactionId);
    }

    async function renderActiveDocumentAfterActivation(runId: number) {
        const document = pdfDocument.value;
        if (!await waitForActivationViewerContainer(runId)) {
            return;
        }
        const transactionId = beginActivationTransaction();
        if (transactionController && transactionId === null) {
            return;
        }
        if (!await restoreCurrentPageViewportForActivation(transactionId)) {
            cancelActivationTransaction(transactionId, 'superseded');
            return;
        }
        if (
            !isActiveDocumentRestoreRunCurrent(runId, document)
            || !isActivationTransactionCurrent(transactionId)
        ) {
            cancelActivationTransaction(transactionId, 'superseded');
            return;
        }

        const activationRange = { ...visibleRange.value };
        advanceActivationTransaction(transactionId, 'render-requested');
        await renderVisiblePages(activationRange, { preserveRenderedPages: true });
        if (
            !isActiveDocumentRestoreRunCurrent(runId, document)
            || !isActivationTransactionCurrent(transactionId)
        ) {
            cancelActivationTransaction(transactionId, 'superseded');
            return;
        }

        const currentRow = getCurrentPageRowRange();
        if (
            hasRenderedContentForPage(currentPage.value)
            && hasRenderedContentForEveryPageInRange(currentRow)
        ) {
            applySearchHighlights();
            settleActivationTransaction(transactionId);
            return;
        }

        if (!rangeContainsPage(visibleRange.value, currentPage.value)) {
            scrollToPage(currentPage.value);
            await waitForActivationRenderFrame();
            if (!commitActivationVisibleRange(transactionId)) {
                cancelActivationTransaction(transactionId, 'superseded');
                return;
            }
            if (
                !isActiveDocumentRestoreRunCurrent(runId, document)
                || !isActivationTransactionCurrent(transactionId)
            ) {
                cancelActivationTransaction(transactionId, 'superseded');
                return;
            }
        }

        advanceActivationTransaction(transactionId, 'render-requested');
        await renderVisiblePages(currentRow, {
            preserveRenderedPages: true,
            forceRerender: true,
            bufferOverride: 0,
        });
        if (
            !isActiveDocumentRestoreRunCurrent(runId, document)
            || !isActivationTransactionCurrent(transactionId)
        ) {
            cancelActivationTransaction(transactionId, 'superseded');
            return;
        }
        applySearchHighlights();
        settleActivationTransaction(transactionId);
    }

    return {
        nextActivationRestoreRunId,
        isActivationRunCurrent,
        isActivationRestoreRunCurrent: isActiveDocumentRestoreRunCurrent,
        renderActiveDocumentAfterActivation,
    };
};
