export const IMAGE_EXPORT_CHANNELS = {
    exportImages: 'pdf-export:images',
    exportMultiPageTiff: 'pdf-export:multipage-tiff',
} as const;

export interface IImageExportCapability {
    exportPdfToImages: (workingCopyPath: string, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPaths?: string[];
    }>;
    exportPdfToMultiPageTiff: (workingCopyPath: string, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPath?: string;
    }>;
}
