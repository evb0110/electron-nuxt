import type { IpcRenderer } from 'electron';
import type { IPageOpsCapability } from '@contracts/electronApiPageOps';
import {
    PAGE_OPS_CHANNELS,
    type IPageOpsInvokeMap,
} from '@electron/features/page-ops/index';
import { createTypedIpcInvoker } from '@electron/preload/ipcClient';

export function createDocumentsPreloadPageOpsClient(
    ipcRenderer: IpcRenderer,
): IPageOpsCapability {
    const invoke = createTypedIpcInvoker<IPageOpsInvokeMap>(ipcRenderer);

    return {
        delete: (workingCopyPath, pages, totalPages) =>
            invoke(PAGE_OPS_CHANNELS.delete, workingCopyPath, pages, totalPages),
        extract: (workingCopyPath, pages) =>
            invoke(PAGE_OPS_CHANNELS.extract, workingCopyPath, pages),
        reorder: (workingCopyPath, newOrder) =>
            invoke(PAGE_OPS_CHANNELS.reorder, workingCopyPath, newOrder),
        insert: (workingCopyPath, totalPages, afterPage) =>
            invoke(PAGE_OPS_CHANNELS.insert, workingCopyPath, totalPages, afterPage),
        insertFile: (
            workingCopyPath,
            totalPages,
            afterPage,
            sourcePaths,
            requestId?: string,
        ) =>
            invoke(PAGE_OPS_CHANNELS.insertFile, workingCopyPath, totalPages, afterPage, sourcePaths, requestId),
        rotate: (workingCopyPath, pages, totalPages, angle) =>
            invoke(PAGE_OPS_CHANNELS.rotate, workingCopyPath, pages, totalPages, angle),
        crop: (workingCopyPath, pages, totalPages, margins) =>
            invoke(PAGE_OPS_CHANNELS.crop, workingCopyPath, pages, totalPages, margins),
        removeCrop: (workingCopyPath, pages, totalPages) =>
            invoke(PAGE_OPS_CHANNELS.removeCrop, workingCopyPath, pages, totalPages),
        getPageGeometry: (workingCopyPath, pageNumber) =>
            invoke(PAGE_OPS_CHANNELS.getPageGeometry, workingCopyPath, pageNumber),
    };
}
