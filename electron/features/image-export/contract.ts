import type {
    IImageExportCapability,
    IImageExportProgress,
} from '@contracts/electronApiDocuments';

export const IMAGE_EXPORT_CHANNELS = {
    exportImages: 'pdfExport:images',
    exportMultiPageTiff: 'pdfExport:multipage-tiff',
} as const;

export const IMAGE_EXPORT_EVENT_CHANNELS = {progress: 'pdfExport:progress'} as const;

export interface IImageExportInvokeMap {
    [IMAGE_EXPORT_CHANNELS.exportImages]: {
        args: [workingCopyPath: string, pageNumbers?: number[], requestId?: string];
        result: Awaited<ReturnType<IImageExportCapability['exportPdfToImages']>>;
    };
    [IMAGE_EXPORT_CHANNELS.exportMultiPageTiff]: {
        args: [workingCopyPath: string, pageNumbers?: number[], requestId?: string];
        result: Awaited<ReturnType<IImageExportCapability['exportPdfToMultiPageTiff']>>;
    };
}

export interface IImageExportEventMap {[IMAGE_EXPORT_EVENT_CHANNELS.progress]: IImageExportProgress;}
