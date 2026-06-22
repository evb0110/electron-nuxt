import type { IPageOpsCapability } from '@contracts/electronApiPageOps';
import type { ICropMargins } from '@contracts/shared';

export const PAGE_OPS_CHANNELS = {
    delete: 'page-ops:delete',
    extract: 'page-ops:extract',
    reorder: 'page-ops:reorder',
    insert: 'page-ops:insert',
    insertFile: 'page-ops:insert-file',
    rotate: 'page-ops:rotate',
    crop: 'page-ops:crop',
    removeCrop: 'page-ops:remove-crop',
    getPageGeometry: 'page-ops:get-page-geometry',
} as const;

type TPageOpsApi = IPageOpsCapability;

export interface IPageOpsInvokeMap {
    [PAGE_OPS_CHANNELS.delete]: {
        args: [workingCopyPath: string, pages: number[], totalPages: number];
        result: Awaited<ReturnType<TPageOpsApi['delete']>>;
    };
    [PAGE_OPS_CHANNELS.extract]: {
        args: [workingCopyPath: string, pages: number[]];
        result: Awaited<ReturnType<TPageOpsApi['extract']>>;
    };
    [PAGE_OPS_CHANNELS.reorder]: {
        args: [workingCopyPath: string, newOrder: number[]];
        result: Awaited<ReturnType<TPageOpsApi['reorder']>>;
    };
    [PAGE_OPS_CHANNELS.insert]: {
        args: [workingCopyPath: string, totalPages: number, afterPage: number];
        result: Awaited<ReturnType<TPageOpsApi['insert']>>;
    };
    [PAGE_OPS_CHANNELS.insertFile]: {
        args: [workingCopyPath: string, totalPages: number, afterPage: number, sourcePaths: string[], requestId?: string];
        result: Awaited<ReturnType<TPageOpsApi['insertFile']>>;
    };
    [PAGE_OPS_CHANNELS.rotate]: {
        args: [workingCopyPath: string, pages: number[], totalPages: number, angle: Parameters<TPageOpsApi['rotate']>[3]];
        result: Awaited<ReturnType<TPageOpsApi['rotate']>>;
    };
    [PAGE_OPS_CHANNELS.crop]: {
        args: [workingCopyPath: string, pages: number[], totalPages: number, margins: ICropMargins];
        result: Awaited<ReturnType<TPageOpsApi['crop']>>;
    };
    [PAGE_OPS_CHANNELS.removeCrop]: {
        args: [workingCopyPath: string, pages: number[], totalPages: number];
        result: Awaited<ReturnType<TPageOpsApi['removeCrop']>>;
    };
    [PAGE_OPS_CHANNELS.getPageGeometry]: {
        args: [workingCopyPath: string, pageNumber: number];
        result: Awaited<ReturnType<TPageOpsApi['getPageGeometry']>>;
    };
}
