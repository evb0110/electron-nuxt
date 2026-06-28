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

export type TPageOpsIpcMainRegistrar = IContractIpcMainRegistrar<IPageOpsInvokeMap, IpcMainInvokeEvent>;

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
    registrar.handle(PAGE_OPS_CHANNELS.delete, (event, workingCopyPath, pages, totalPages) =>
        service.delete(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages));
    registrar.handle(PAGE_OPS_CHANNELS.extract, (event, workingCopyPath, pages) =>
        service.extract(createPageOpsOperationContext(event), workingCopyPath, pages));
    registrar.handle(PAGE_OPS_CHANNELS.reorder, (event, workingCopyPath, newOrder) =>
        service.reorder(createPageOpsOperationContext(event), workingCopyPath, newOrder));
    registrar.handle(PAGE_OPS_CHANNELS.insert, (event, workingCopyPath, totalPages, afterPage) =>
        service.insert(createPageOpsOperationContext(event), workingCopyPath, totalPages, afterPage));
    registrar.handle(
        PAGE_OPS_CHANNELS.insertFile,
        (event, workingCopyPath, totalPages, afterPage, sourcePaths, requestId) =>
            service.insertFile(createPageOpsOperationContext(event), workingCopyPath, totalPages, afterPage, sourcePaths, requestId),
    );
    registrar.handle(PAGE_OPS_CHANNELS.rotate, (event, workingCopyPath, pages, totalPages, angle) =>
        service.rotate(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages, angle));
    registrar.handle(PAGE_OPS_CHANNELS.crop, (event, workingCopyPath, pages, totalPages, margins) =>
        service.crop(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages, margins));
    registrar.handle(PAGE_OPS_CHANNELS.removeCrop, (event, workingCopyPath, pages, totalPages) =>
        service.removeCrop(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages));
    registrar.handle(PAGE_OPS_CHANNELS.getPageGeometry, (event, workingCopyPath, pageNumber) =>
        service.getPageGeometry(createPageOpsOperationContext(event), workingCopyPath, pageNumber));
}
