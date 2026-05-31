import type { IpcMainInvokeEvent } from 'electron';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import type { IImageExportInvokeMap } from '@electron/features/image-export/contract';

export type IIpcMainRegistrar = IContractIpcMainRegistrar<IImageExportInvokeMap>;

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
