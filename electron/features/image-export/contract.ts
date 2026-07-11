import type {
    IImageExportCapability,
    IImageExportProgress,
} from '@contracts/electronApiDocuments';

export const IMAGE_EXPORT_CHANNELS = {
    exportImages: 'pdfExport:images',
    exportMultiPageTiff: 'pdfExport:multipage-tiff',
    subscribeProgress: 'pdfExport:progress:subscribe',
} as const;

export const IMAGE_EXPORT_EVENT_CHANNELS = {progress: 'pdfExport:progress'} as const;

export interface IImageExportInvokeMap {
    [IMAGE_EXPORT_CHANNELS.exportImages]: {
        args: [workingCopyPath: string, pageNumbers: number[] | undefined, requestId: string | undefined, sourceKind: 'pdf' | 'djvu' | undefined];
        result: Awaited<ReturnType<IImageExportCapability['exportPdfToImages']>>;
    };
    [IMAGE_EXPORT_CHANNELS.exportMultiPageTiff]: {
        args: [workingCopyPath: string, pageNumbers: number[] | undefined, requestId: string | undefined, sourceKind: 'pdf' | 'djvu' | undefined];
        result: Awaited<ReturnType<IImageExportCapability['exportPdfToMultiPageTiff']>>;
    };
    [IMAGE_EXPORT_CHANNELS.subscribeProgress]: {
        args: [];
        result: undefined;
    };
}

export interface IImageExportEventMap {[IMAGE_EXPORT_EVENT_CHANNELS.progress]: IImageExportProgress;}
