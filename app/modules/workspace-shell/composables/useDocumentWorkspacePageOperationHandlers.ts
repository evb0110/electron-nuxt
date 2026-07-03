import type { Ref } from 'vue';

interface IDocumentWorkspacePageOperationControls {
    handlePageRotate: (pages: number[], degrees: 90 | 180 | 270) => unknown;
    pageOpsDelete: (pages: number[], totalPages: number) => unknown;
    pageOpsExtract: (pages: number[]) => unknown;
    pageOpsInsert: (totalPages: number, afterPage: number) => unknown;
    pageOpsReorder: (order: number[]) => unknown;
}

interface IUseDocumentWorkspacePageOperationHandlersOptions {
    documentControls: IDocumentWorkspacePageOperationControls;
    handleExportImages: (pages?: number[]) => unknown;
    selectedThumbnailPages: Ref<number[]>;
    totalPages: Ref<number>;
}

export const useDocumentWorkspacePageOperationHandlers = (options: IUseDocumentWorkspacePageOperationHandlersOptions) => {
    function handleDeletePages() {
        const pages = options.selectedThumbnailPages.value;
        if (pages.length > 0) {
            void options.documentControls.pageOpsDelete(pages, options.totalPages.value);
        }
    }

    function handleExtractPages() {
        const pages = options.selectedThumbnailPages.value;
        if (pages.length > 0) {
            void options.documentControls.pageOpsExtract(pages);
        }
    }

    function handleRotateCw() {
        const pages = options.selectedThumbnailPages.value;
        if (pages.length > 0) {
            void options.documentControls.handlePageRotate(pages, 90);
        }
    }

    function handleRotateCcw() {
        const pages = options.selectedThumbnailPages.value;
        if (pages.length > 0) {
            void options.documentControls.handlePageRotate(pages, 270);
        }
    }

    function handlePageRotateCw(pages: number[]) {
        void options.documentControls.handlePageRotate(pages, 90);
    }

    function handlePageRotateCcw(pages: number[]) {
        void options.documentControls.handlePageRotate(pages, 270);
    }

    function handlePageExtract(pages: number[]) {
        void options.documentControls.pageOpsExtract(pages);
    }

    function handlePageExport(pages: number[]) {
        void options.handleExportImages(pages);
    }

    function handlePageDelete(pages: number[]) {
        void options.documentControls.pageOpsDelete(pages, options.totalPages.value);
    }

    function handlePageReorder(order: number[]) {
        void options.documentControls.pageOpsReorder(order);
    }

    function handleInsertPages() {
        void options.documentControls.pageOpsInsert(options.totalPages.value, options.totalPages.value);
    }

    return {
        handleDeletePages,
        handleExtractPages,
        handleInsertPages,
        handlePageDelete,
        handlePageExport,
        handlePageExtract,
        handlePageReorder,
        handlePageRotateCcw,
        handlePageRotateCw,
        handleRotateCcw,
        handleRotateCw,
    };
};
