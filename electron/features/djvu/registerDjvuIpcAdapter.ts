import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
} from 'electron';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import {
    DJVU_CHANNELS,
    type IDjvuInvokeMap,
} from '@electron/features/djvu/contract';
import {createDjvuService} from '@electron/features/djvu/createDjvuService';
import { createLogger } from '@electron/utils/createLogger';
import { sweepStaleDjvuTempPdfs } from '@electron/features/djvu/main/viewing';
import type { IDjvuService } from '@electron/features/djvu/ports';

export type TDjvuIpcMainRegistrar = IContractIpcMainRegistrar<IDjvuInvokeMap, IpcMainInvokeEvent>;

const logger = createLogger('djvu-ipc');

function createDjvuOperationContext(event: IpcMainInvokeEvent) {
    return {
        sender: event.sender,
        senderId: event.sender.id,
        parentWindow: BrowserWindow.fromWebContents(event.sender),
    };
}

export function registerDjvuIpcAdapter(
    registrar: TDjvuIpcMainRegistrar = ipcMain,
    service: IDjvuService = createDjvuService(),
) {
    registrar.handle(DJVU_CHANNELS.openForViewing, (event, djvuPath) =>
        service.openForViewing(createDjvuOperationContext(event), djvuPath));
    registrar.handle(DJVU_CHANNELS.releaseViewingPath, (event, djvuPath) =>
        service.releaseViewingPath(createDjvuOperationContext(event), djvuPath));
    registrar.handle(DJVU_CHANNELS.convertToPdf, (event, djvuPath, outputPath, options) =>
        service.convertToPdf(createDjvuOperationContext(event), djvuPath, outputPath, options));
    registrar.handle(DJVU_CHANNELS.printDjvuPath, (event, djvuPath, options) =>
        service.printDjvuPath(createDjvuOperationContext(event), djvuPath, options));
    registrar.handle(DJVU_CHANNELS.cancel, (event, jobId) =>
        service.cancel(createDjvuOperationContext(event), jobId));
    registrar.handle(DJVU_CHANNELS.cancelPagePreview, (event, requestId) =>
        service.cancelPagePreview(createDjvuOperationContext(event), requestId));
    registrar.handle(DJVU_CHANNELS.getInfo, (event, djvuPath) =>
        service.getInfo(createDjvuOperationContext(event), djvuPath));
    registrar.handle(DJVU_CHANNELS.getPageSizes, (event, djvuPath) =>
        service.getPageSizes(createDjvuOperationContext(event), djvuPath));
    registrar.handle(DJVU_CHANNELS.renderPagePreview, (event, djvuPath, pageNumber, options) =>
        service.renderPagePreview(createDjvuOperationContext(event), djvuPath, pageNumber, options));
    registrar.handle(DJVU_CHANNELS.estimateSizes, (event, djvuPath) =>
        service.estimateSizes(createDjvuOperationContext(event), djvuPath));
    registrar.handle(DJVU_CHANNELS.cleanupTemp, (event, tempPdfPath) =>
        service.cleanupTemp(createDjvuOperationContext(event), tempPdfPath));
    registrar.handle(DJVU_CHANNELS.subscribeProgress, (event) => {
        service.subscribeProgress(createDjvuOperationContext(event));
        return undefined;
    });

    if (process.env.EVB_DJVU_SWEEP_STALE_TEMP !== '0') {
        void sweepStaleDjvuTempPdfs().catch((error: unknown) => {
            logger.warn(`DjVu stale temp cleanup failed: ${String(error)}`);
        });
    }
}
