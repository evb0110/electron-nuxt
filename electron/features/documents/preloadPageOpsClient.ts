import type { IpcRenderer } from 'electron';
import type { IPageOpsCapability } from '@contracts/platformApi';
import type { TPageOpsRotationAngle } from '@contracts/electronApiPageOps';
import {
    PAGE_OPS_CHANNELS,
    type IPageOpsInvokeMap,
} from '@electron/features/page-ops/index';
import { createTypedIpcInvoker } from '@electron/preload/ipcClient';
import type { ICropMargins } from '@contracts/shared';

export function createDocumentsPreloadPageOpsClient(
    ipcRenderer: IpcRenderer,
): IPageOpsCapability['pageOps'] {
    const invoke = createTypedIpcInvoker<IPageOpsInvokeMap>(ipcRenderer);

    return {
        delete: (workingCopyPath: string, pages: number[], totalPages: number) =>
            invoke(PAGE_OPS_CHANNELS.delete, workingCopyPath, pages, totalPages),
        extract: (workingCopyPath: string, pages: number[]) =>
            invoke(PAGE_OPS_CHANNELS.extract, workingCopyPath, pages),
        reorder: (workingCopyPath: string, newOrder: number[]) =>
            invoke(PAGE_OPS_CHANNELS.reorder, workingCopyPath, newOrder),
        insert: (workingCopyPath: string, totalPages: number, afterPage: number) =>
            invoke(PAGE_OPS_CHANNELS.insert, workingCopyPath, totalPages, afterPage),
        insertFile: (
            workingCopyPath: string,
            totalPages: number,
            afterPage: number,
            sourcePaths: string[],
            requestId?: string,
        ) =>
            invoke(PAGE_OPS_CHANNELS.insertFile, workingCopyPath, totalPages, afterPage, sourcePaths, requestId),
        rotate: (workingCopyPath: string, pages: number[], angle: TPageOpsRotationAngle) =>
            invoke(PAGE_OPS_CHANNELS.rotate, workingCopyPath, pages, angle),
        crop: (workingCopyPath: string, pages: number[], margins: ICropMargins) =>
            invoke(PAGE_OPS_CHANNELS.crop, workingCopyPath, pages, margins),
        removeCrop: (workingCopyPath: string, pages: number[]) =>
            invoke(PAGE_OPS_CHANNELS.removeCrop, workingCopyPath, pages),
        getPageGeometry: (workingCopyPath: string, pageNumber: number) =>
            invoke(PAGE_OPS_CHANNELS.getPageGeometry, workingCopyPath, pageNumber),
    };
}
