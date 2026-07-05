import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
} from 'electron';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import {
    IMAGE_EXPORT_CHANNELS,
    type IImageExportInvokeMap,
} from '@electron/features/image-export/contract';
import { createImageExportService } from '@electron/features/image-export/createImageExportService';
import type { IImageExportService } from '@electron/features/image-export/ports';

export type TImageExportIpcMainRegistrar = IContractIpcMainRegistrar<IImageExportInvokeMap, IpcMainInvokeEvent>;

export function registerImageExportIpcAdapter(
    registrar: TImageExportIpcMainRegistrar = ipcMain,
    service: IImageExportService = createImageExportService(),
) {
    registrar.handle(
        IMAGE_EXPORT_CHANNELS.exportImages,
        (event, workingCopyPath: string, pageNumbers?: number[], requestId?: string) =>
            service.exportImages(
                {
                    sender: event.sender,
                    senderId: event.sender.id,
                    parentWindow: BrowserWindow.fromWebContents(event.sender),
                },
                workingCopyPath,
                pageNumbers,
                requestId,
            ),
    );
    registrar.handle(
        IMAGE_EXPORT_CHANNELS.exportMultiPageTiff,
        (event, workingCopyPath: string, pageNumbers?: number[], requestId?: string) =>
            service.exportMultiPageTiff(
                {
                    sender: event.sender,
                    senderId: event.sender.id,
                    parentWindow: BrowserWindow.fromWebContents(event.sender),
                },
                workingCopyPath,
                pageNumbers,
                requestId,
            ),
    );
    registrar.handle(
        IMAGE_EXPORT_CHANNELS.subscribeProgress,
        (event) => {
            service.subscribeProgress({
                sender: event.sender,
                senderId: event.sender.id,
                parentWindow: BrowserWindow.fromWebContents(event.sender),
            });
            return undefined;
        },
    );
}
