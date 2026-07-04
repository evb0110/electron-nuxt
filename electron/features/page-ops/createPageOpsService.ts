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
        delete: (context, workingCopyPath, pages, totalPages, options) =>
            handlePageOpsDelete(context, workingCopyPath, pages, totalPages, options),
        extract: (context, workingCopyPath, pages) =>
            handlePageOpsExtract(context, workingCopyPath, pages),
        reorder: (context, workingCopyPath, newOrder, options) =>
            handlePageOpsReorder(context, workingCopyPath, newOrder, options),
        insert: (context, workingCopyPath, totalPages, afterPage, options) =>
            handlePageOpsInsert(context, workingCopyPath, totalPages, afterPage, options),
        insertFile: (context, workingCopyPath, totalPages, afterPage, sourcePaths, requestId, options) =>
            handlePageOpsInsertFile(context, workingCopyPath, totalPages, afterPage, sourcePaths, requestId, options),
        rotate: (context, workingCopyPath, pages, totalPages, angle, options) =>
            handlePageOpsRotate(context, workingCopyPath, pages, totalPages, angle, options),
        crop: (context, workingCopyPath, pages, totalPages, margins, options) =>
            handlePageOpsCrop(context, workingCopyPath, pages, totalPages, margins, options),
        removeCrop: (context, workingCopyPath, pages, totalPages, options) =>
            handlePageOpsRemoveCrop(context, workingCopyPath, pages, totalPages, options),
        getPageGeometry: (context, workingCopyPath, pageNumber) =>
            handlePageOpsGetPageGeometry(context, workingCopyPath, pageNumber),
    };
}
