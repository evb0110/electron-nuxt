import {
    handlePdfExportImages,
    handlePdfExportMultiPageTiff,
} from '@electron/features/image-export/main/ipc';
import type { IImageExportService } from '@electron/features/image-export/ports';

export function createImageExportService(): IImageExportService {
    return {
        exportImages: (context, workingCopyPath, pageNumbers, requestId) =>
            handlePdfExportImages(context, workingCopyPath, pageNumbers, requestId),
        exportMultiPageTiff: (context, workingCopyPath, pageNumbers, requestId) =>
            handlePdfExportMultiPageTiff(context, workingCopyPath, pageNumbers, requestId),
    };
}
