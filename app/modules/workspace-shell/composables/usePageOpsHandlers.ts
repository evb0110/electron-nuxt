import type { Ref } from 'vue';
import { difference } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type { ICropMargins } from '@app/types/crop';
import type { TDocumentRef } from '@contracts/platformApi';
import { usePageOperations } from '@app/composables/pdf/usePageOperations';

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
        onExtractedDocument,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache,
        ensureWorkingCopyFreshForRead,
    } = deps;

    const {
        isOperationInProgress: isPageOperationInProgress,
        batchProgress: pageOpBatchProgress,
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
    });

    function handlePageContextMenuDelete() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void pageOpsDelete(pages, totalPages.value);
    }

    function handlePageContextMenuExtract() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void pageOpsExtract(pages);
    }

    function handlePageContextMenuExport() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        onExportPages([...pages]);
    }

    async function handlePageRotate(pages: number[], angle: 90 | 180 | 270) {
        const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
        const didRotate = await pageOpsRotate(pages, angle);
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
        void pageOpsInsert(totalPages.value, Math.min(...pages) - 1);
    }

    function handlePageContextMenuInsertAfter() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void pageOpsInsert(totalPages.value, Math.max(...pages));
    }

    function handlePageFileDrop(payload: {
        afterPage: number;
        filePaths: TDocumentRef[];
    }) {
        void pageOpsInsertFile(totalPages.value, payload.afterPage, payload.filePaths);
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
        // Cropping changes page geometry, so forcing selective rerendering
        // reuses stale layout metrics and can visibly stretch pages.
        const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
        const didCrop = await pageOpsCrop(pages, margins);
        if (!didCrop) {
            reloadWaiter.cancel();
            return false;
        }
        await reloadWaiter.promise;
        return true;
    }

    async function handleRemoveCrop(pages: number[]) {
        // Removing crop also changes the effective viewport size.
        const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
        const didRemoveCrop = await pageOpsRemoveCrop(pages);
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
        pageOpsDelete,
        pageOpsExtract,
        pageOpsInsert,
        pageOpsReorder,
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
