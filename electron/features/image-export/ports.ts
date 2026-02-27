import type { IpcMainInvokeEvent } from 'electron';

export interface IImageExportService {
    exportImages: (
        event: IpcMainInvokeEvent,
        workingCopyPath: string,
        pageNumbers?: number[],
    ) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPaths?: string[];
    }>;
    exportMultiPageTiff: (
        event: IpcMainInvokeEvent,
        workingCopyPath: string,
        pageNumbers?: number[],
    ) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPath?: string;
    }>;
}
