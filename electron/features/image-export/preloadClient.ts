import type { IpcRenderer } from 'electron';
import type { IImageExportCapability } from '@contracts/platformApi';
import {
    IMAGE_EXPORT_CHANNELS,
    type IImageExportInvokeMap,
} from '@electron/features/image-export/index';
import { createTypedIpcInvoker } from '@electron/preload/ipcClient';

export function createImageExportPreloadClient(
    ipcRenderer: Pick<IpcRenderer, 'invoke'>,
): IImageExportCapability {
    const invoke = createTypedIpcInvoker<IImageExportInvokeMap>(ipcRenderer);

    return {
        exportPdfToImages: (workingPath: string, pageNumbers?: number[]) =>
            invoke(IMAGE_EXPORT_CHANNELS.exportImages, workingPath, pageNumbers),
        exportPdfToMultiPageTiff: (workingPath: string, pageNumbers?: number[]) =>
            invoke(IMAGE_EXPORT_CHANNELS.exportMultiPageTiff, workingPath, pageNumbers),
    };
}
