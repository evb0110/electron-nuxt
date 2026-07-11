import {
    handlePdfExportImages,
    handlePdfExportMultiPageTiff,
    subscribeImageExportProgress,
} from '@electron/features/image-export/main/ipc';
import type { IImageExportService } from '@electron/features/image-export/ports';

export function createImageExportService(): IImageExportService {
    return {
        exportImages: (context, workingCopyPath, pageNumbers, requestId, sourceKind) =>
            handlePdfExportImages(context, workingCopyPath, pageNumbers, requestId, sourceKind),
        exportMultiPageTiff: (context, workingCopyPath, pageNumbers, requestId, sourceKind) =>
            handlePdfExportMultiPageTiff(context, workingCopyPath, pageNumbers, requestId, sourceKind),
        subscribeProgress: context => subscribeImageExportProgress(context.sender),
    };
}
