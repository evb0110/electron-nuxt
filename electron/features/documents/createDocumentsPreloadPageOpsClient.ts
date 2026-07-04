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
        delete: (workingCopyPath, pages, totalPages, options) =>
            invoke(PAGE_OPS_CHANNELS.delete, workingCopyPath, pages, totalPages, options),
        extract: (workingCopyPath, pages) =>
            invoke(PAGE_OPS_CHANNELS.extract, workingCopyPath, pages),
        reorder: (workingCopyPath, newOrder, options) =>
            invoke(PAGE_OPS_CHANNELS.reorder, workingCopyPath, newOrder, options),
        insert: (workingCopyPath, totalPages, afterPage, options) =>
            invoke(PAGE_OPS_CHANNELS.insert, workingCopyPath, totalPages, afterPage, options),
        insertFile: (
            workingCopyPath,
            totalPages,
            afterPage,
            sourcePaths,
            requestId?: string,
            options?,
        ) =>
            invoke(PAGE_OPS_CHANNELS.insertFile, workingCopyPath, totalPages, afterPage, sourcePaths, requestId, options),
        rotate: (workingCopyPath, pages, totalPages, angle, options) =>
            invoke(PAGE_OPS_CHANNELS.rotate, workingCopyPath, pages, totalPages, angle, options),
        crop: (workingCopyPath, pages, totalPages, margins, options) =>
            invoke(PAGE_OPS_CHANNELS.crop, workingCopyPath, pages, totalPages, margins, options),
        removeCrop: (workingCopyPath, pages, totalPages, options) =>
            invoke(PAGE_OPS_CHANNELS.removeCrop, workingCopyPath, pages, totalPages, options),
        getPageGeometry: (workingCopyPath, pageNumber) =>
            invoke(PAGE_OPS_CHANNELS.getPageGeometry, workingCopyPath, pageNumber),
    };
}
