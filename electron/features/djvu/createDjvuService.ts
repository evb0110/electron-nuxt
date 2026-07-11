import {
    handleDjvuCancelOperation,
    handleDjvuCancelPagePreview,
    handleDjvuCleanupTemp,
    handleDjvuConvertToPdfOperation,
    handleDjvuEstimateSizes,
    handleDjvuGetInfo,
    handleDjvuGetPageSizes,
    handleDjvuOpenForViewingOperation,
    handleDjvuStartOpenForViewingOperation,
    handleDjvuAwaitOpenJobOperation,
    handleDjvuStartConvertToPdfOperation,
    handleDjvuAwaitConvertJobOperation,
    handleDjvuPrintPathOperation,
    handleDjvuReleaseViewingPath,
    handleDjvuRenderPagePreview,
} from '@electron/features/djvu/main/djvuOperations';
import {
    getDjvuOutputJobState,
    subscribeDjvuOutputJob,
    subscribeDjvuProgress,
} from '@electron/features/djvu/main/pdfExport';
import type { IDjvuService } from '@electron/features/djvu/ports';

export function createDjvuService(): IDjvuService {
    return {
        startOpenForViewing: handleDjvuStartOpenForViewingOperation,
        awaitOpenJob: handleDjvuAwaitOpenJobOperation,
        openForViewing: handleDjvuOpenForViewingOperation,
        releaseViewingPath: (context, djvuPath) => {
            handleDjvuReleaseViewingPath(context, djvuPath);
            return Promise.resolve();
        },
        convertToPdf: handleDjvuConvertToPdfOperation,
        startConvertToPdf: handleDjvuStartConvertToPdfOperation,
        awaitConvertJob: handleDjvuAwaitConvertJobOperation,
        printDjvuPath: handleDjvuPrintPathOperation,
        cancel: handleDjvuCancelOperation,
        getJobState: (_context, jobId) => Promise.resolve(getDjvuOutputJobState(jobId)),
        subscribeJob: (context, jobId) => Promise.resolve(subscribeDjvuOutputJob(context, jobId)),
        cancelPagePreview: handleDjvuCancelPagePreview,
        getInfo: handleDjvuGetInfo,
        getPageSizes: handleDjvuGetPageSizes,
        renderPagePreview: handleDjvuRenderPagePreview,
        estimateSizes: handleDjvuEstimateSizes,
        cleanupTemp: handleDjvuCleanupTemp,
        subscribeProgress: context => subscribeDjvuProgress(context),
    };
}
