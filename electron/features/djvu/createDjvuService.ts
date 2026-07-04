import {
    handleDjvuCancelOperation,
    handleDjvuCleanupTemp,
    handleDjvuConvertToPdfOperation,
    handleDjvuEstimateSizes,
    handleDjvuGetInfo,
    handleDjvuGetPageSizes,
    handleDjvuOpenForViewingOperation,
    handleDjvuPrintPathOperation,
    handleDjvuReleaseViewingPath,
    handleDjvuRenderPagePreview,
} from '@electron/features/djvu/main/djvuOperations';
import type { IDjvuService } from '@electron/features/djvu/ports';

export function createDjvuService(): IDjvuService {
    return {
        openForViewing: (context, djvuPath) =>
            handleDjvuOpenForViewingOperation(context, djvuPath),
        releaseViewingPath: (context, djvuPath) => {
            handleDjvuReleaseViewingPath(context, djvuPath);
            return Promise.resolve();
        },
        convertToPdf: (context, djvuPath, outputPath, options) =>
            handleDjvuConvertToPdfOperation(context, djvuPath, outputPath, options),
        printDjvuPath: (context, djvuPath, options) =>
            handleDjvuPrintPathOperation(context, djvuPath, options),
        cancel: (context, jobId) =>
            handleDjvuCancelOperation(context, jobId),
        getInfo: (context, djvuPath) =>
            handleDjvuGetInfo(context, djvuPath),
        getPageSizes: (context, djvuPath) =>
            handleDjvuGetPageSizes(context, djvuPath),
        renderPagePreview: (context, djvuPath, pageNumber, options) =>
            handleDjvuRenderPagePreview(context, djvuPath, pageNumber, options),
        estimateSizes: (context, djvuPath) =>
            handleDjvuEstimateSizes(context, djvuPath),
        cleanupTemp: (context, tempPdfPath) =>
            handleDjvuCleanupTemp(context, tempPdfPath),
    };
}
