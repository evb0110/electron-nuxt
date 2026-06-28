import {
    handlePageOpsCrop,
    handlePageOpsDelete,
    handlePageOpsExtract,
    handlePageOpsGetPageGeometry,
    handlePageOpsInsert,
    handlePageOpsInsertFile,
    handlePageOpsRemoveCrop,
    handlePageOpsReorder,
    handlePageOpsRotate,
} from '@electron/features/page-ops/main/pageOpsOperations';
import type { IPageOpsService } from '@electron/features/page-ops/ports';

export function createPageOpsService(): IPageOpsService {
    return {
        delete: (context, workingCopyPath, pages, totalPages) =>
            handlePageOpsDelete(context, workingCopyPath, pages, totalPages),
        extract: (context, workingCopyPath, pages) =>
            handlePageOpsExtract(context, workingCopyPath, pages),
        reorder: (context, workingCopyPath, newOrder) =>
            handlePageOpsReorder(context, workingCopyPath, newOrder),
        insert: (context, workingCopyPath, totalPages, afterPage) =>
            handlePageOpsInsert(context, workingCopyPath, totalPages, afterPage),
        insertFile: (context, workingCopyPath, totalPages, afterPage, sourcePaths, requestId) =>
            handlePageOpsInsertFile(context, workingCopyPath, totalPages, afterPage, sourcePaths, requestId),
        rotate: (context, workingCopyPath, pages, totalPages, angle) =>
            handlePageOpsRotate(context, workingCopyPath, pages, totalPages, angle),
        crop: (context, workingCopyPath, pages, totalPages, margins) =>
            handlePageOpsCrop(context, workingCopyPath, pages, totalPages, margins),
        removeCrop: (context, workingCopyPath, pages, totalPages) =>
            handlePageOpsRemoveCrop(context, workingCopyPath, pages, totalPages),
        getPageGeometry: (context, workingCopyPath, pageNumber) =>
            handlePageOpsGetPageGeometry(context, workingCopyPath, pageNumber),
    };
}
