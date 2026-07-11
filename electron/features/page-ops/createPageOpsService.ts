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
        delete: handlePageOpsDelete,
        extract: handlePageOpsExtract,
        reorder: handlePageOpsReorder,
        insert: handlePageOpsInsert,
        insertFile: handlePageOpsInsertFile,
        rotate: handlePageOpsRotate,
        crop: handlePageOpsCrop,
        removeCrop: handlePageOpsRemoveCrop,
        getPageGeometry: handlePageOpsGetPageGeometry,
    };
}
