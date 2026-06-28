import type {
    BrowserWindow,
    WebContents,
} from 'electron';
import type { IPageOpsCapability } from '@contracts/electronApiPageOps';

type TPageOpsApi = IPageOpsCapability;

export interface IPageOpsOperationContext {
    sender: WebContents;
    senderId: number;
    parentWindow: BrowserWindow | null;
}

export interface IPageOpsService {
    delete: (context: IPageOpsOperationContext, ...args: Parameters<TPageOpsApi['delete']>) => ReturnType<TPageOpsApi['delete']>;
    extract: (context: IPageOpsOperationContext, ...args: Parameters<TPageOpsApi['extract']>) => ReturnType<TPageOpsApi['extract']>;
    reorder: (context: IPageOpsOperationContext, ...args: Parameters<TPageOpsApi['reorder']>) => ReturnType<TPageOpsApi['reorder']>;
    insert: (context: IPageOpsOperationContext, ...args: Parameters<TPageOpsApi['insert']>) => ReturnType<TPageOpsApi['insert']>;
    insertFile: (context: IPageOpsOperationContext, ...args: Parameters<TPageOpsApi['insertFile']>) => ReturnType<TPageOpsApi['insertFile']>;
    rotate: (context: IPageOpsOperationContext, ...args: Parameters<TPageOpsApi['rotate']>) => ReturnType<TPageOpsApi['rotate']>;
    crop: (context: IPageOpsOperationContext, ...args: Parameters<TPageOpsApi['crop']>) => ReturnType<TPageOpsApi['crop']>;
    removeCrop: (context: IPageOpsOperationContext, ...args: Parameters<TPageOpsApi['removeCrop']>) => ReturnType<TPageOpsApi['removeCrop']>;
    getPageGeometry: (
        context: IPageOpsOperationContext,
        ...args: Parameters<TPageOpsApi['getPageGeometry']>
    ) => ReturnType<TPageOpsApi['getPageGeometry']>;
}
