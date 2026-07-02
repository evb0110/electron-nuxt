import type { IpcRenderer } from 'electron';
import type { IPageOpsCapability } from '@contracts/electronApiPageOps';
import {
    PAGE_OPS_CHANNELS,
    type IPageOpsInvokeMap,
} from '@electron/features/page-ops/index';
import { createTypedIpcInvoker } from '@electron/preload/ipcClient';

const PAGE_OPS_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1000;
const PAGE_OPS_INVOKE_TIMEOUT_MS_BY_CHANNEL = {
    [PAGE_OPS_CHANNELS.delete]: PAGE_OPS_NATIVE_IPC_TIMEOUT_MS,
    [PAGE_OPS_CHANNELS.extract]: PAGE_OPS_NATIVE_IPC_TIMEOUT_MS,
    [PAGE_OPS_CHANNELS.reorder]: PAGE_OPS_NATIVE_IPC_TIMEOUT_MS,
    [PAGE_OPS_CHANNELS.insert]: PAGE_OPS_NATIVE_IPC_TIMEOUT_MS,
    [PAGE_OPS_CHANNELS.insertFile]: PAGE_OPS_NATIVE_IPC_TIMEOUT_MS,
    [PAGE_OPS_CHANNELS.rotate]: PAGE_OPS_NATIVE_IPC_TIMEOUT_MS,
    [PAGE_OPS_CHANNELS.crop]: PAGE_OPS_NATIVE_IPC_TIMEOUT_MS,
    [PAGE_OPS_CHANNELS.removeCrop]: PAGE_OPS_NATIVE_IPC_TIMEOUT_MS,
    [PAGE_OPS_CHANNELS.getPageGeometry]: PAGE_OPS_NATIVE_IPC_TIMEOUT_MS,
} as const;

export function createDocumentsPreloadPageOpsClient(
    ipcRenderer: IpcRenderer,
): IPageOpsCapability {
    const invoke = createTypedIpcInvoker<IPageOpsInvokeMap>(ipcRenderer, {invokeTimeoutMsByChannel: PAGE_OPS_INVOKE_TIMEOUT_MS_BY_CHANNEL});

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
