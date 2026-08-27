import type { Ref } from 'vue';
import type {
    TPageMoveOperation,
    TPageSelection,
} from '@contracts/pageNumbers';

type TPageSelectionInput = number[] | TPageSelection;

interface IDocumentWorkspacePageOperationControls {
    handlePageRotate: (pages: TPageSelectionInput, degrees: 90 | 180 | 270) => unknown;
    pageOpsDelete: (pages: TPageSelectionInput, totalPages: number) => unknown;
    pageOpsExtract: (pages: TPageSelectionInput) => unknown;
    pageOpsInsert: (totalPages: number, afterPage: number) => unknown;
    pageOpsReorder: (order: number[]) => unknown;
    pageOpsMove: (move: TPageMoveOperation) => unknown;
}

interface IUseDocumentWorkspacePageOperationHandlersOptions {
    documentControls: IDocumentWorkspacePageOperationControls;
    handleExportImages: (pages?: TPageSelectionInput) => unknown;
    ensurePdfProjectionForEdit?: () => Promise<boolean>;
    selectedThumbnailPages: Ref<number[]>;
    selectedPageSelection?: Ref<TPageSelection | null>;
    totalPages: Ref<number>;
}

export const useDocumentWorkspacePageOperationHandlers = (options: IUseDocumentWorkspacePageOperationHandlersOptions) => {
    async function runEditAction(action: () => unknown) {
        if (options.ensurePdfProjectionForEdit && !await options.ensurePdfProjectionForEdit()) {
            return;
        }
        await action();
    }

    function getSelectedPagePayload(): TPageSelectionInput {
        const selection = options.selectedPageSelection?.value;
        if (selection && selection.pageCount === options.totalPages.value) {
            return selection;
        }
        return options.selectedThumbnailPages.value;
    }

    function handleDeletePages() {
        const pages = getSelectedPagePayload();
        if (Array.isArray(pages) ? pages.length > 0 : pages.kind !== 'none') {
            void runEditAction(() => options.documentControls.pageOpsDelete(pages, options.totalPages.value));
        }
    }

    function handleExtractPages() {
        const pages = getSelectedPagePayload();
        if (Array.isArray(pages) ? pages.length > 0 : pages.kind !== 'none') {
            void runEditAction(() => options.documentControls.pageOpsExtract(pages));
        }
    }

    function handleRotateCw() {
        const pages = getSelectedPagePayload();
        if (Array.isArray(pages) ? pages.length > 0 : pages.kind !== 'none') {
            void runEditAction(() => options.documentControls.handlePageRotate(pages, 90));
        }
    }

    function handleRotateCcw() {
        const pages = getSelectedPagePayload();
        if (Array.isArray(pages) ? pages.length > 0 : pages.kind !== 'none') {
            void runEditAction(() => options.documentControls.handlePageRotate(pages, 270));
        }
    }

    function handlePageRotateCw(pages: TPageSelectionInput) {
        void runEditAction(() => options.documentControls.handlePageRotate(pages, 90));
    }

    function handlePageRotateCcw(pages: TPageSelectionInput) {
        void runEditAction(() => options.documentControls.handlePageRotate(pages, 270));
    }

    function handlePageExtract(pages: TPageSelectionInput) {
        void runEditAction(() => options.documentControls.pageOpsExtract(pages));
    }

    function handlePageExport(pages: TPageSelectionInput) {
        void options.handleExportImages(pages);
    }

    function handlePageDelete(pages: TPageSelectionInput) {
        void runEditAction(() => options.documentControls.pageOpsDelete(pages, options.totalPages.value));
    }

    function handlePageReorder(order: number[]) {
        void runEditAction(() => options.documentControls.pageOpsReorder(order));
    }

    function handlePageMove(move: TPageMoveOperation) {
        void runEditAction(() => options.documentControls.pageOpsMove(move));
    }

    function handleInsertPages() {
        void runEditAction(() => options.documentControls.pageOpsInsert(options.totalPages.value, options.totalPages.value));
    }

    return {
        handleDeletePages,
        handleExtractPages,
        handleInsertPages,
        handlePageDelete,
        handlePageExport,
        handlePageExtract,
        handlePageReorder,
        handlePageMove,
        handlePageRotateCcw,
        handlePageRotateCw,
        handleRotateCcw,
        handleRotateCw,
    };
};
