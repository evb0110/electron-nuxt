import type { Ref } from 'vue';
import { difference } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type { ICropMargins } from '@app/types/crop';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';
import {
    getPageIdentityDeltaNextPageCount,
    mapPageNumberThroughPageIdentityDelta,
    type IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import type {
    IPageMoveRangeSegment,
    TPageMoveOperation,
    TPageSelection,
} from '@contracts/pageNumbers';
import {
    createAllPageSelection,
    createExplicitPageSelection,
    createMappedPageSelection,
    invertPageSelection,
    iteratePageSelectionBatches,
    iteratePageSelectionRanges,
    materializePageSelection,
    mapPageNumberAfterPageMove,
    pageSelectionCount,
} from '@contracts/pageNumbers';
import { usePageOperations } from '@app/modules/pdf-viewer/public';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { runDetached } from '@app/utils/asyncGuard';

type TPageSelectionInput = number[] | TPageSelection;
const PAGE_OPERATION_BATCH_SIZE = 10_000;
const PAGE_OPERATION_RANGE_LIMIT = 100_000;

interface IPdfViewerForPageOps {
    invalidatePages: (pages: number[]) => void;
    remapPageIdentityDelta?: (delta: IPageIdentityDelta) => void;
}

export interface IPageOpsHandlersDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
    pageLabels: Ref<string[] | null>;
    pageLabelRanges?: Ref<IPdfPageLabelRange[]>;
    pageLabelsResolved?: Ref<boolean>;
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    bookmarksResolved?: Ref<boolean>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    selectedThumbnailPages: Ref<number[]>;
    setSelectedThumbnailPages: (pages: number[]) => void;
    selectedPageSelection?: Ref<TPageSelection | null>;
    setSelectedPageSelection?: (selection: TPageSelection) => void;
    invalidateThumbnailPages: (pages: number[]) => void;
    pdfViewerRef: Ref<IPdfViewerForPageOps | null>;
    pageContextMenu: Ref<{
        visible: boolean;
        pages: number[]
    }>;
    closePageContextMenu: () => void;
    onExportPages: (pages: TPageSelectionInput) => void;
    canMutatePages?: Ref<boolean>;
    onExtractedDocument?: (path: TDocumentRef) => Promise<void> | void;
    ensureHistoryBaselineForMutation: () => Promise<boolean>;
    materializeAnnotationsForPageMutation: () => Promise<boolean>;
    reloadWorkingCopyIntoHistory: (opts?: { markDirty?: boolean }) => Promise<boolean>;
    preparePdfReloadWaiter: (
        pageToRestore: number,
        opts?: { captureScrollSnapshot?: boolean },
    ) => {
        promise: Promise<void>;
        cancel: () => void;
    };
    clearOcrCache: (path: TDocumentRef) => void;
    resetSearchCache: () => void;
    ensureWorkingCopyFreshForRead?: () => Promise<boolean>;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

export const usePageOpsHandlers = (deps: IPageOpsHandlersDeps) => {
    const {
        workingCopyPath,
        documentRevisionToken,
        pageLabels,
        pageLabelRanges,
        pageLabelsResolved,
        bookmarkItems,
        bookmarksResolved,
        currentPage,
        totalPages,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        selectedPageSelection,
        setSelectedPageSelection,
        pageContextMenu,
        closePageContextMenu,
        onExportPages,
        canMutatePages,
        onExtractedDocument,
        ensureHistoryBaselineForMutation,
        materializeAnnotationsForPageMutation,
        reloadWorkingCopyIntoHistory,
        preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache,
        ensureWorkingCopyFreshForRead,
        runWithDocumentOperationLease,
    } = deps;

    function runPageOperationDetached(label: string, task: () => Promise<unknown>) {
        runDetached(task, {
            category: 'user-visible-operation',
            scope: 'page-operations',
            message: `Failed to ${label}`,
        });
    }

    const {
        isOperationInProgress: isPageOperationInProgress,
        batchProgress: pageOpBatchProgress,
        lastOutcome: lastPageOperationOutcome,
        deletePages: pageOpsDelete,
        deletePageRanges: pageOpsDeleteRanges,
        extractPages: pageOpsExtract,
        rotatePages: pageOpsRotate,
        insertPages: pageOpsInsert,
        insertFile: pageOpsInsertFile,
        reorderPages: pageOpsReorder,
        movePages: pageOpsMove,
        cropPages: pageOpsCrop,
        removeCrop: pageOpsRemoveCrop,
    } = usePageOperations({
        workingCopyPath,
        ...(documentRevisionToken !== undefined ? { documentRevisionToken } : {}),
        pageLabels,
        ...(pageLabelRanges !== undefined ? {pageLabelRanges} : {}),
        ...(pageLabelsResolved !== undefined ? {pageLabelsResolved} : {}),
        bookmarkItems,
        ...(bookmarksResolved !== undefined ? {bookmarksResolved} : {}),
        ensureHistoryBaselineForMutation,
        materializeAnnotationsForPageMutation,
        reloadWorkingCopyIntoHistory,
        clearOcrCache,
        resetSearchCache,
        ...(ensureWorkingCopyFreshForRead !== undefined ? { ensureWorkingCopyFreshForRead } : {}),
        ...(onExtractedDocument !== undefined ? { onExtractedDocument } : {}),
        ...(runWithDocumentOperationLease !== undefined ? { runWithDocumentOperationLease } : {}),
    });

    const hasPageSelectionModel = selectedPageSelection !== undefined
        && setSelectedPageSelection !== undefined;

    function getCurrentPageSelection(): TPageSelection {
        const selection = selectedPageSelection?.value;
        if (selection && selection.pageCount === totalPages.value) {
            return selection;
        }
        return createExplicitPageSelection(totalPages.value, selectedThumbnailPages.value);
    }

    function normalizePageSelectionInput(
        pages: TPageSelectionInput,
        expectedTotalPages = totalPages.value,
    ): TPageSelection {
        if (Array.isArray(pages)) {
            return createExplicitPageSelection(expectedTotalPages, pages);
        }
        return pages.pageCount === expectedTotalPages
            ? pages
            : createExplicitPageSelection(expectedTotalPages, []);
    }

    function iteratePageOperationBatches(
        pages: TPageSelectionInput,
        expectedTotalPages = totalPages.value,
    ) {
        return iteratePageSelectionBatches(
            normalizePageSelectionInput(pages, expectedTotalPages),
            {batchSize: PAGE_OPERATION_BATCH_SIZE},
        );
    }

    function publishPageSelection(selection: TPageSelection) {
        if (hasPageSelectionModel) {
            setSelectedPageSelection(selection);
        }
        // Existing consumers still use the array for menus and small-document
        // operations. Keep that compatibility without expanding a large lazy
        // selection into a document-sized renderer collection.
        setSelectedThumbnailPages(pageSelectionCount(selection) <= 100_000
            ? materializePageSelection(selection)
            : []);
    }

    function collectCompactPageSelectionRanges(selection: TPageSelection): IPageMoveRangeSegment[] | null {
        const ranges: IPageMoveRangeSegment[] = [];
        for (const range of iteratePageSelectionRanges(selection)) {
            ranges.push(range);
            if (ranges.length > PAGE_OPERATION_RANGE_LIMIT) {
                return null;
            }
        }
        return ranges;
    }

    function getDeleteRangesForSelection(
        selection: TPageSelection,
        expectedTotalPages: number,
    ): IPageMoveRangeSegment[] | null {
        const selectedCount = pageSelectionCount(selection);
        if (selectedCount === 0) {
            return [];
        }
        if (selectedCount >= expectedTotalPages) {
            // Keep the first page so qpdf never has to create an empty PDF.
            return expectedTotalPages > 1
                ? [{
                    startPage: 2,
                    endPage: expectedTotalPages,
                }]
                : [];
        }
        return collectCompactPageSelectionRanges(selection);
    }

    function isPdfPageOperationBlocked() {
        return canMutatePages?.value === false;
    }

    async function runStructuralPageMutation(
        run: () => Promise<boolean>,
        remapSelection: (pages: readonly number[]) => number[] = () => [],
    ) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        const didSucceed = await run();
        if (didSucceed) {
            const outcome = lastPageOperationOutcome?.value;
            const delta = outcome?.status === 'succeeded' && 'pageIdentityDelta' in outcome.result
                ? outcome.result.pageIdentityDelta
                : undefined;
            if (delta) {
                const mappedPageNumber = mapPageNumberThroughPageIdentityDelta(delta, currentPage.value);
                const nextPageCount = getPageIdentityDeltaNextPageCount(delta);
                currentPage.value = mappedPageNumber
                    ?? Math.min(currentPage.value, nextPageCount ?? currentPage.value);
                deps.pdfViewerRef.value?.remapPageIdentityDelta?.(delta);
            }
            setSelectedThumbnailPages(remapSelection(selectedThumbnailPages.value));
        }
        return didSucceed;
    }

    async function pageOpsDeleteAndClearSelection(
        pages: TPageSelectionInput,
        expectedTotalPages: number,
    ) {
        if (!Array.isArray(pages)) {
            const selection = normalizePageSelectionInput(pages, expectedTotalPages);
            const selectedCount = pageSelectionCount(selection);
            if (selectedCount === 0) {
                return false;
            }

            const compactDeleteRanges = getDeleteRangesForSelection(selection, expectedTotalPages);
            if (compactDeleteRanges !== null) {
                if (compactDeleteRanges.length === 0) {
                    return false;
                }
                const deletedCount = compactDeleteRanges.reduce(
                    (count, range) => count + range.endPage - range.startPage + 1,
                    0,
                );
                const didDelete = await runStructuralPageMutation(
                    () => pageOpsDeleteRanges(compactDeleteRanges, expectedTotalPages),
                );
                if (!didDelete) {
                    return false;
                }
                publishPageSelection({
                    kind: 'none',
                    pageCount: Math.max(0, expectedTotalPages - deletedCount),
                });
                return true;
            }

            let deletedCount = 0;
            for (const batch of iteratePageOperationBatches(selection, expectedTotalPages)) {
                const pagesAfterPriorDeletes = batch.map(page => page - deletedCount);
                const didDelete = await runStructuralPageMutation(
                    () => pageOpsDelete(
                        pagesAfterPriorDeletes,
                        expectedTotalPages - deletedCount,
                    ),
                );
                if (!didDelete) {
                    return false;
                }
                deletedCount += batch.length;
            }

            publishPageSelection({
                kind: 'none',
                pageCount: Math.max(0, expectedTotalPages - deletedCount),
            });
            return true;
        }
        const deleted = new Set(pages);
        return runStructuralPageMutation(
            () => pageOpsDelete(pages, expectedTotalPages),
            selection => selection.flatMap((page) => {
                if (deleted.has(page)) {
                    return [];
                }
                return [page - pages.filter(deletedPage => deletedPage < page).length];
            }),
        );
    }

    async function pageOpsInsertAndClearSelection(expectedTotalPages: number, afterPage: number) {
        return runStructuralPageMutation(() => pageOpsInsert(expectedTotalPages, afterPage));
    }

    async function pageOpsInsertFileAndClearSelection(
        expectedTotalPages: number,
        afterPage: number,
        filePaths: TDocumentRef[],
    ) {
        return runStructuralPageMutation(() => pageOpsInsertFile(expectedTotalPages, afterPage, filePaths));
    }

    async function pageOpsReorderAndClearSelection(newOrder: number[]) {
        const newPageByOldPage = new Map(newOrder.map((oldPage, index) => [
            oldPage,
            index + 1,
        ]));
        return runStructuralPageMutation(
            () => pageOpsReorder(newOrder),
            selection => selection.flatMap(page => newPageByOldPage.get(page) ?? []),
        );
    }

    async function pageOpsMoveAndClearSelection(move: TPageMoveOperation) {
        const selectionBeforeMove = selectedPageSelection?.value;
        const didMove = await runStructuralPageMutation(
            () => pageOpsMove(move),
            selection => selection
                .map(page => mapPageNumberAfterPageMove(page, move))
                .sort((left, right) => left - right),
        );
        if (didMove && hasPageSelectionModel && selectionBeforeMove?.pageCount === move.pageCount) {
            publishPageSelection(createMappedPageSelection(selectionBeforeMove, move));
        }
        return didMove;
    }

    async function pageOpsExtractWithDjvuGuard(pages: TPageSelectionInput) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        if (Array.isArray(pages)) {
            return pageOpsExtract(pages);
        }
        const selection = normalizePageSelectionInput(pages);
        if (pageSelectionCount(selection) === 0) {
            return false;
        }
        for (const batch of iteratePageOperationBatches(selection)) {
            if (!await pageOpsExtract(batch)) {
                return false;
            }
        }
        return true;
    }

    function handlePageContextMenuDelete() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        runPageOperationDetached('delete PDF pages', () => pageOpsDeleteAndClearSelection(pages, totalPages.value));
    }

    function handlePageContextMenuExtract() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        runPageOperationDetached('extract PDF pages', () => pageOpsExtractWithDjvuGuard(pages));
    }

    function handlePageContextMenuExport() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        if (isPdfPageOperationBlocked()) {
            return;
        }
        onExportPages([...pages]);
    }

    async function handlePageRotate(pages: TPageSelectionInput, angle: 90 | 180 | 270) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
        let didRotate = true;
        if (Array.isArray(pages)) {
            didRotate = await pageOpsRotate(pages, totalPages.value, angle);
        } else {
            const selection = normalizePageSelectionInput(pages);
            if (pageSelectionCount(selection) === 0) {
                reloadWaiter.cancel();
                return false;
            }
            for (const batch of iteratePageOperationBatches(selection)) {
                if (!await pageOpsRotate(batch, totalPages.value, angle)) {
                    didRotate = false;
                    break;
                }
            }
        }
        if (!didRotate) {
            reloadWaiter.cancel();
            return false;
        }
        await reloadWaiter.promise;
        return true;
    }

    function handlePageContextMenuRotateCw() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        runPageOperationDetached('rotate PDF pages', () => handlePageRotate(pages, 90));
    }

    function handlePageContextMenuRotateCcw() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        runPageOperationDetached('rotate PDF pages', () => handlePageRotate(pages, 270));
    }

    function handlePageContextMenuInsertBefore() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        if (pages.length === 0) {
            return;
        }
        runPageOperationDetached(
            'insert PDF pages',
            () => pageOpsInsertAndClearSelection(totalPages.value, Math.min(...pages) - 1),
        );
    }

    function handlePageContextMenuInsertAfter() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        if (pages.length === 0) {
            return;
        }
        runPageOperationDetached(
            'insert PDF pages',
            () => pageOpsInsertAndClearSelection(totalPages.value, Math.max(...pages)),
        );
    }

    function handlePageFileDrop(payload: {
        afterPage: number;
        filePaths: TDocumentRef[];
    }) {
        if (isPdfPageOperationBlocked()) {
            return;
        }
        runPageOperationDetached(
            'insert PDF files',
            () => pageOpsInsertFileAndClearSelection(totalPages.value, payload.afterPage, payload.filePaths),
        );
    }

    function handlePageContextMenuSelectAll() {
        closePageContextMenu();
        if (totalPages.value <= 0) {
            return;
        }
        if (hasPageSelectionModel) {
            publishPageSelection(createAllPageSelection(totalPages.value));
            return;
        }
        const allPages = range(1, totalPages.value + 1);
        setSelectedThumbnailPages(allPages);
    }

    function handlePageContextMenuInvertSelection() {
        closePageContextMenu();
        if (totalPages.value <= 0) {
            return;
        }
        if (hasPageSelectionModel) {
            publishPageSelection(invertPageSelection(getCurrentPageSelection()));
            return;
        }
        setSelectedThumbnailPages(difference(
            range(1, totalPages.value + 1),
            selectedThumbnailPages.value,
        ));
    }

    async function handleCropPages(pages: number[] | TPageSelection, margins: ICropMargins) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        // Cropping changes page geometry, so forcing selective rerendering
        // reuses stale layout metrics and can visibly stretch pages.
        const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
        const didCrop = await pageOpsCrop(pages, totalPages.value, margins);
        if (!didCrop) {
            reloadWaiter.cancel();
            return false;
        }
        await reloadWaiter.promise;
        return true;
    }

    async function handleRemoveCrop(pages: number[] | TPageSelection) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        // Removing crop also changes the effective viewport size.
        const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
        const didRemoveCrop = await pageOpsRemoveCrop(pages, totalPages.value);
        if (!didRemoveCrop) {
            reloadWaiter.cancel();
            return false;
        }
        await reloadWaiter.promise;
        return true;
    }

    return {
        isPageOperationInProgress,
        pageOpBatchProgress,
        lastPageOperationOutcome,
        pageOpsDelete: pageOpsDeleteAndClearSelection,
        pageOpsExtract: pageOpsExtractWithDjvuGuard,
        pageOpsInsert: pageOpsInsertAndClearSelection,
        pageOpsReorder: pageOpsReorderAndClearSelection,
        pageOpsMove: pageOpsMoveAndClearSelection,
        handlePageContextMenuDelete,
        handlePageContextMenuExtract,
        handlePageContextMenuExport,
        handlePageRotate,
        handlePageContextMenuRotateCw,
        handlePageContextMenuRotateCcw,
        handlePageContextMenuInsertBefore,
        handlePageContextMenuInsertAfter,
        handlePageFileDrop,
        handlePageContextMenuSelectAll,
        handlePageContextMenuInvertSelection,
        handleCropPages,
        handleRemoveCrop,
    };
};
