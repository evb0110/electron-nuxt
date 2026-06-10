import {
    handlePdfExportImages,
    handlePdfExportMultiPageTiff,
} from '@electron/features/image-export/main/ipc';
import type { IImageExportService } from '@electron/features/image-export/ports';

export function createImageExportService(): IImageExportService {
    return {
        exportImages: (event, workingCopyPath, pageNumbers, requestId) =>
            handlePdfExportImages(event, workingCopyPath, pageNumbers, requestId),
        exportMultiPageTiff: (event, workingCopyPath, pageNumbers, requestId) =>
            handlePdfExportMultiPageTiff(event, workingCopyPath, pageNumbers, requestId),
    };
}
