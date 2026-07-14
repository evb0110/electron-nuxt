import type {
    IDjvuCapability,
    IDjvuProgress,
    IDjvuTextSearchProgress,
} from '@contracts/electronApiDjvu';

export const DJVU_CHANNELS = {
    startOpenForViewing: 'djvu:open:start',
    awaitOpenJob: 'djvu:open:await',
    openForViewing: 'djvu:openForViewing',
    releaseViewingPath: 'djvu:releaseViewingPath',
    convertToPdf: 'djvu:convertToPdf',
    startConvertToPdf: 'djvu:convert:start',
    awaitConvertJob: 'djvu:convert:await',
    printDjvuPath: 'djvu:printDjvuPath',
    cancel: 'djvu:cancel',
    getJobState: 'djvu:job:getState',
    subscribeJob: 'djvu:job:subscribe',
    cancelPagePreview: 'djvu:cancelPagePreview',
    searchText: 'djvu:text:search',
    cancelTextSearch: 'djvu:text:cancel',
    getInfo: 'djvu:getInfo',
    getPageSourceInfo: 'djvu:getPageSourceInfo',
    getPageSizes: 'djvu:getPageSizes',
    renderPagePreview: 'djvu:renderPagePreview',
    estimateSizes: 'djvu:estimateSizes',
    cleanupTemp: 'djvu:cleanupTemp',
    subscribeProgress: 'djvu:progress:subscribe',
} as const;

export const DJVU_EVENT_CHANNELS = {
    progress: 'djvu:progress',
    textSearchProgress: 'djvu:text:progress',
    menuConvertToPdf: 'menu:convertToPdf',
} as const;

export interface IDjvuInvokeMap {
    [DJVU_CHANNELS.startOpenForViewing]: {
        args: Parameters<IDjvuCapability['startOpenForViewing']>;
        result: Awaited<ReturnType<IDjvuCapability['startOpenForViewing']>>;
    };
    [DJVU_CHANNELS.awaitOpenJob]: {
        args: Parameters<IDjvuCapability['awaitOpenJob']>;
        result: Awaited<ReturnType<IDjvuCapability['awaitOpenJob']>>;
    };
    [DJVU_CHANNELS.openForViewing]: {
        args: [djvuPath: string];
        result: Awaited<ReturnType<IDjvuCapability['openForViewing']>>;
    };
    [DJVU_CHANNELS.releaseViewingPath]: {
        args: [djvuPath: string];
        result: Awaited<ReturnType<IDjvuCapability['releaseViewingPath']>>;
    };
    [DJVU_CHANNELS.convertToPdf]: {
        args: [djvuPath: string, outputPath: string, options: Parameters<IDjvuCapability['convertToPdf']>[2]];
        result: Awaited<ReturnType<IDjvuCapability['convertToPdf']>>;
    };
    [DJVU_CHANNELS.startConvertToPdf]: {
        args: Parameters<IDjvuCapability['startConvertToPdf']>;
        result: Awaited<ReturnType<IDjvuCapability['startConvertToPdf']>>;
    };
    [DJVU_CHANNELS.awaitConvertJob]: {
        args: Parameters<IDjvuCapability['awaitConvertJob']>;
        result: Awaited<ReturnType<IDjvuCapability['awaitConvertJob']>>;
    };
    [DJVU_CHANNELS.printDjvuPath]: {
        args: [djvuPath: string, options: Parameters<IDjvuCapability['printDjvuPath']>[1]];
        result: Awaited<ReturnType<IDjvuCapability['printDjvuPath']>>;
    };
    [DJVU_CHANNELS.cancel]: {
        args: [jobId: string];
        result: Awaited<ReturnType<IDjvuCapability['cancel']>>;
    };
    [DJVU_CHANNELS.getJobState]: {
        args: [jobId: string];
        result: Awaited<ReturnType<IDjvuCapability['getJobState']>>;
    };
    [DJVU_CHANNELS.subscribeJob]: {
        args: [jobId: string];
        result: Awaited<ReturnType<IDjvuCapability['subscribeJob']>>;
    };
    [DJVU_CHANNELS.cancelPagePreview]: {
        args: [requestId: string];
        result: Awaited<ReturnType<IDjvuCapability['cancelPagePreview']>>;
    };
    [DJVU_CHANNELS.searchText]: {
        args: Parameters<IDjvuCapability['searchText']>;
        result: Awaited<ReturnType<IDjvuCapability['searchText']>>;
    };
    [DJVU_CHANNELS.cancelTextSearch]: {
        args: Parameters<IDjvuCapability['cancelTextSearch']>;
        result: Awaited<ReturnType<IDjvuCapability['cancelTextSearch']>>;
    };
    [DJVU_CHANNELS.getInfo]: {
        args: [djvuPath: string];
        result: Awaited<ReturnType<IDjvuCapability['getInfo']>>;
    };
    [DJVU_CHANNELS.getPageSourceInfo]: {
        args: Parameters<IDjvuCapability['getPageSourceInfo']>;
        result: Awaited<ReturnType<IDjvuCapability['getPageSourceInfo']>>;
    };
    [DJVU_CHANNELS.getPageSizes]: {
        args: [djvuPath: string];
        result: Awaited<ReturnType<IDjvuCapability['getPageSizes']>>;
    };
    [DJVU_CHANNELS.renderPagePreview]: {
        args: [
            djvuPath: string,
            pageNumber: number,
            options?: Parameters<IDjvuCapability['renderPagePreview']>[2],
        ];
        result: Awaited<ReturnType<IDjvuCapability['renderPagePreview']>>;
    };
    [DJVU_CHANNELS.estimateSizes]: {
        args: [djvuPath: string];
        result: Awaited<ReturnType<IDjvuCapability['estimateSizes']>>;
    };
    [DJVU_CHANNELS.cleanupTemp]: {
        args: [tempPdfPath: string];
        result: Awaited<ReturnType<IDjvuCapability['cleanupTemp']>>;
    };
    [DJVU_CHANNELS.subscribeProgress]: {
        args: [];
        result: undefined;
    };
}

export interface IDjvuEventMap {
    [DJVU_EVENT_CHANNELS.progress]: IDjvuProgress;
    [DJVU_EVENT_CHANNELS.textSearchProgress]: IDjvuTextSearchProgress;
    [DJVU_EVENT_CHANNELS.menuConvertToPdf]: undefined;
}
