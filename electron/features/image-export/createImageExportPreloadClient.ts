import type { IpcRenderer } from 'electron';
import type { IImageExportCapability } from '@contracts/electronApiDocuments';
import {
    IMAGE_EXPORT_EVENT_CHANNELS,
    IMAGE_EXPORT_CHANNELS,
    type IImageExportEventMap,
    type IImageExportInvokeMap,
} from '@electron/features/image-export/index';
import {
    createTypedIpcEventSubscriber,
    createTypedIpcInvoker,
} from '@electron/preload/ipcClient';

export function createImageExportPreloadClient(
    ipcRenderer: IpcRenderer,
): IImageExportCapability {
    const invoke = createTypedIpcInvoker<IImageExportInvokeMap>(ipcRenderer);
    const eventSubscriber = createTypedIpcEventSubscriber<IImageExportEventMap>(ipcRenderer);

    return {
        exportPdfToImages: (workingPath, pageNumbers?: number[], requestId?: string) =>
            invoke(IMAGE_EXPORT_CHANNELS.exportImages, workingPath, pageNumbers, requestId),
        exportPdfToMultiPageTiff: (workingPath, pageNumbers?: number[], requestId?: string) =>
            invoke(IMAGE_EXPORT_CHANNELS.exportMultiPageTiff, workingPath, pageNumbers, requestId),
        onProgress: (callback): (() => void) =>
            eventSubscriber.onPayload(IMAGE_EXPORT_EVENT_CHANNELS.progress, callback),
    };
}
