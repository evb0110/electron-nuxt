import type {
    BrowserWindow,
    WebContents,
} from 'electron';

export interface IImageExportOperationContext {
    sender: WebContents;
    senderId: number;
    parentWindow: BrowserWindow | null;
}

export interface IImageExportService {
    exportImages: (
        context: IImageExportOperationContext,
        workingCopyPath: string,
        pageNumbers?: number[],
        requestId?: string,
    ) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPaths?: string[];
    }>;
    exportMultiPageTiff: (
        context: IImageExportOperationContext,
        workingCopyPath: string,
        pageNumbers?: number[],
        requestId?: string,
    ) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPath?: string;
        outputPaths?: string[];
    }>;
}
