import type {
    BrowserWindow,
    WebContents,
} from 'electron';
import type { IDjvuCapability } from '@contracts/electronApiDjvu';

type TDjvuApi = IDjvuCapability;

export interface IDjvuOperationContext {
    sender: WebContents;
    senderId: number;
    parentWindow: BrowserWindow | null;
}

export interface IDjvuService {
    startOpenForViewing: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['startOpenForViewing']>
    ) => ReturnType<TDjvuApi['startOpenForViewing']>;
    awaitOpenJob: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['awaitOpenJob']>
    ) => ReturnType<TDjvuApi['awaitOpenJob']>;
    openForViewing: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['openForViewing']>
    ) => ReturnType<TDjvuApi['openForViewing']>;
    releaseViewingPath: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['releaseViewingPath']>
    ) => ReturnType<TDjvuApi['releaseViewingPath']>;
    convertToPdf: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['convertToPdf']>
    ) => ReturnType<TDjvuApi['convertToPdf']>;
    startConvertToPdf: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['startConvertToPdf']>
    ) => ReturnType<TDjvuApi['startConvertToPdf']>;
    awaitConvertJob: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['awaitConvertJob']>
    ) => ReturnType<TDjvuApi['awaitConvertJob']>;
    printDjvuPath: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['printDjvuPath']>
    ) => ReturnType<TDjvuApi['printDjvuPath']>;
    cancel: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['cancel']>
    ) => ReturnType<TDjvuApi['cancel']>;
    getJobState: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['getJobState']>
    ) => ReturnType<TDjvuApi['getJobState']>;
    subscribeJob: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['subscribeJob']>
    ) => ReturnType<TDjvuApi['subscribeJob']>;
    cancelPagePreview: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['cancelPagePreview']>
    ) => ReturnType<TDjvuApi['cancelPagePreview']>;
    getInfo: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['getInfo']>
    ) => ReturnType<TDjvuApi['getInfo']>;
    getPageSizes: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['getPageSizes']>
    ) => ReturnType<TDjvuApi['getPageSizes']>;
    renderPagePreview: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['renderPagePreview']>
    ) => ReturnType<TDjvuApi['renderPagePreview']>;
    estimateSizes: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['estimateSizes']>
    ) => ReturnType<TDjvuApi['estimateSizes']>;
    cleanupTemp: (
        context: IDjvuOperationContext,
        ...args: Parameters<TDjvuApi['cleanupTemp']>
    ) => ReturnType<TDjvuApi['cleanupTemp']>;
    subscribeProgress: (context: IDjvuOperationContext) => void;
}
