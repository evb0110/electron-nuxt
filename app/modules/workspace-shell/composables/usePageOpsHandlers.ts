import type { Ref } from 'vue';
import { difference } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type { ICropMargins } from '@app/types/crop';
import type { TDocumentRef } from '@contracts/documentRef';
import { usePageOperations } from '@app/modules/pdf-viewer/public';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';

interface IPdfViewerForPageOps {invalidatePages: (pages: number[]) => void;}

export interface IPageOpsHandlersDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    selectedThumbnailPages: Ref<number[]>;
    setSelectedThumbnailPages: (pages: number[]) => void;
    invalidateThumbnailPages: (pages: number[]) => void;
    pdfViewerRef: Ref<IPdfViewerForPageOps | null>;
    pageContextMenu: Ref<{
        visible: boolean;
        pages: number[] 
    }>;
    closePageContextMenu: () => void;
    onExportPages: (pages: number[]) => void;
    canMutatePages?: Ref<boolean>;
    onExtractedDocument?: (path: TDocumentRef) => Promise<void> | void;
    ensureHistoryBaselineForExternalMutation: () => Promise<boolean>;
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
        currentPage,
        totalPages,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        pageContextMenu,
        closePageContextMenu,
        onExportPages,
        canMutatePages,
        onExtractedDocument,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache,
        ensureWorkingCopyFreshForRead,
        runWithDocumentOperationLease,
    } = deps;

    const {
        isOperationInProgress: isPageOperationInProgress,
        batchProgress: pageOpBatchProgress,
        lastOutcome: lastPageOperationOutcome,
        deletePages: pageOpsDelete,
        extractPages: pageOpsExtract,
        rotatePages: pageOpsRotate,
        insertPages: pageOpsInsert,
        insertFile: pageOpsInsertFile,
        reorderPages: pageOpsReorder,
        cropPages: pageOpsCrop,
        removeCrop: pageOpsRemoveCrop,
    } = usePageOperations({
        workingCopyPath,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        clearOcrCache,
        resetSearchCache,
        ...(ensureWorkingCopyFreshForRead !== undefined ? { ensureWorkingCopyFreshForRead } : {}),
        ...(onExtractedDocument !== undefined ? { onExtractedDocument } : {}),
        ...(runWithDocumentOperationLease !== undefined ? { runWithDocumentOperationLease } : {}),
    });

    function isPdfPageOperationBlocked() {
        return canMutatePages?.value === false;
    }

    async function runStructuralPageMutation(run: () => Promise<boolean>) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        const didSucceed = await run();
        if (didSucceed) {
            setSelectedThumbnailPages([]);
        }
        return didSucceed;
    }

    async function pageOpsDeleteAndClearSelection(pages: number[], expectedTotalPages: number) {
        return runStructuralPageMutation(() => pageOpsDelete(pages, expectedTotalPages));
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
        return runStructuralPageMutation(() => pageOpsReorder(newOrder));
    }

    async function pageOpsExtractWithDjvuGuard(pages: number[]) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        return pageOpsExtract(pages);
    }

    function handlePageContextMenuDelete() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void pageOpsDeleteAndClearSelection(pages, totalPages.value);
    }

    function handlePageContextMenuExtract() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void pageOpsExtractWithDjvuGuard(pages);
    }

    function handlePageContextMenuExport() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        if (isPdfPageOperationBlocked()) {
            return;
        }
        onExportPages([...pages]);
    }

    async function handlePageRotate(pages: number[], angle: 90 | 180 | 270) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
        const didRotate = await pageOpsRotate(pages, totalPages.value, angle);
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
        void handlePageRotate(pages, 90);
    }

    function handlePageContextMenuRotateCcw() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void handlePageRotate(pages, 270);
    }

    function handlePageContextMenuInsertBefore() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        if (pages.length === 0) {
            return;
        }
        void pageOpsInsertAndClearSelection(totalPages.value, Math.min(...pages) - 1);
    }

    function handlePageContextMenuInsertAfter() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        if (pages.length === 0) {
            return;
        }
        void pageOpsInsertAndClearSelection(totalPages.value, Math.max(...pages));
    }

    function handlePageFileDrop(payload: {
        afterPage: number;
        filePaths: TDocumentRef[];
    }) {
        if (isPdfPageOperationBlocked()) {
            return;
        }
        void pageOpsInsertFileAndClearSelection(totalPages.value, payload.afterPage, payload.filePaths);
    }

    function handlePageContextMenuSelectAll() {
        closePageContextMenu();
        if (totalPages.value <= 0) {
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
        setSelectedThumbnailPages(difference(
            range(1, totalPages.value + 1),
            selectedThumbnailPages.value,
        ));
    }

    async function handleCropPages(pages: number[], margins: ICropMargins) {
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

    async function handleRemoveCrop(pages: number[]) {
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
