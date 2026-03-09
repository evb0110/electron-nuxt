import {
    handlePdfExportImages,
    handlePdfExportMultiPageTiff,
} from '@electron/features/image-export/main/ipc';
import type { IImageExportService } from '@electron/features/image-export/ports';

export function createImageExportService(): IImageExportService {
    return {
        exportImages: (event, workingCopyPath, pageNumbers) =>
            handlePdfExportImages(event, workingCopyPath, pageNumbers),
        exportMultiPageTiff: (event, workingCopyPath, pageNumbers) =>
            handlePdfExportMultiPageTiff(event, workingCopyPath, pageNumbers),
    };
}
