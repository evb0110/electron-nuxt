import type { IpcMainInvokeEvent } from 'electron';
import { IMAGE_EXPORT_CHANNELS } from '@electron/features/image-export/contract';
import {createImageExportService} from '@electron/features/image-export/service';
import type {
    TImageExportIpcMainRegistrar,
    IImageExportService,
} from '@electron/features/image-export/ports';

export function registerImageExportIpcAdapter(
    registrar: TImageExportIpcMainRegistrar,
    service: IImageExportService = createImageExportService(),
) {
    registrar.handle(
        IMAGE_EXPORT_CHANNELS.exportImages,
        (event: IpcMainInvokeEvent, workingCopyPath: string, pageNumbers?: number[]) =>
            service.exportImages(event, workingCopyPath, pageNumbers),
    );
    registrar.handle(
        IMAGE_EXPORT_CHANNELS.exportMultiPageTiff,
        (event: IpcMainInvokeEvent, workingCopyPath: string, pageNumbers?: number[]) =>
            service.exportMultiPageTiff(event, workingCopyPath, pageNumbers),
    );
}
