import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
} from 'electron';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import {
    PAGE_OPS_CHANNELS,
    type IPageOpsInvokeMap,
} from '@electron/features/page-ops/contract';
import { createPageOpsService } from '@electron/features/page-ops/createPageOpsService';
import type { IPageOpsService } from '@electron/features/page-ops/ports';
import type { IValidatedIpcMainRegistrar } from '@electron/platform-ipc/validatedIpcRegistrar';

export type TPageOpsIpcMainRegistrar =
    IContractIpcMainRegistrar<IPageOpsInvokeMap, IpcMainInvokeEvent>
    | IValidatedIpcMainRegistrar<IPageOpsInvokeMap, IpcMainInvokeEvent>;

function createPageOpsOperationContext(event: IpcMainInvokeEvent) {
    return {
        sender: event.sender,
        senderId: event.sender.id,
        parentWindow: BrowserWindow.fromWebContents(event.sender),
    };
}

export function registerPageOpsIpcAdapter(
    registrar: TPageOpsIpcMainRegistrar = ipcMain,
    service: IPageOpsService = createPageOpsService(),
) {
    registrar.handle(PAGE_OPS_CHANNELS.delete, (event, workingCopyPath, pages, totalPages, options) =>
        service.delete(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages, options));
    registrar.handle(PAGE_OPS_CHANNELS.extract, (event, workingCopyPath, pages) =>
        service.extract(createPageOpsOperationContext(event), workingCopyPath, pages));
    registrar.handle(PAGE_OPS_CHANNELS.reorder, (event, workingCopyPath, newOrder, options) =>
        service.reorder(createPageOpsOperationContext(event), workingCopyPath, newOrder, options));
    registrar.handle(PAGE_OPS_CHANNELS.insert, (event, workingCopyPath, totalPages, afterPage, options) =>
        service.insert(createPageOpsOperationContext(event), workingCopyPath, totalPages, afterPage, options));
    registrar.handle(
        PAGE_OPS_CHANNELS.insertFile,
        (event, workingCopyPath, totalPages, afterPage, sourcePaths, requestId, options) =>
            service.insertFile(createPageOpsOperationContext(event), workingCopyPath, totalPages, afterPage, sourcePaths, requestId, options),
    );
    registrar.handle(PAGE_OPS_CHANNELS.rotate, (event, workingCopyPath, pages, totalPages, angle, options) =>
        service.rotate(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages, angle, options));
    registrar.handle(PAGE_OPS_CHANNELS.crop, (event, workingCopyPath, pages, totalPages, margins, options) =>
        service.crop(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages, margins, options));
    registrar.handle(PAGE_OPS_CHANNELS.removeCrop, (event, workingCopyPath, pages, totalPages, options) =>
        service.removeCrop(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages, options));
    registrar.handle(PAGE_OPS_CHANNELS.getPageGeometry, (event, workingCopyPath, pageNumber) =>
        service.getPageGeometry(createPageOpsOperationContext(event), workingCopyPath, pageNumber));
}
