import type { IImageExportCapability } from '@contracts/electronApiDocuments';

export const IMAGE_EXPORT_CHANNELS = {
    exportImages: 'pdfExport:images',
    exportMultiPageTiff: 'pdfExport:multipage-tiff',
} as const;

export interface IImageExportInvokeMap {
    [IMAGE_EXPORT_CHANNELS.exportImages]: {
        args: [workingCopyPath: string, pageNumbers?: number[]];
        result: Awaited<ReturnType<IImageExportCapability['exportPdfToImages']>>;
    };
    [IMAGE_EXPORT_CHANNELS.exportMultiPageTiff]: {
        args: [workingCopyPath: string, pageNumbers?: number[]];
        result: Awaited<ReturnType<IImageExportCapability['exportPdfToMultiPageTiff']>>;
    };
}
