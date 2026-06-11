import type {
    IDjvuCapability,
    IDjvuProgress,
    IDjvuViewingErrorEvent,
    IDjvuViewingReadyEvent,
} from '@contracts/electronApiDjvu';

export const DJVU_CHANNELS = {
    openForViewing: 'djvu:openForViewing',
    releaseViewingPath: 'djvu:releaseViewingPath',
    convertToPdf: 'djvu:convertToPdf',
    cancel: 'djvu:cancel',
    getInfo: 'djvu:getInfo',
    getPageSizes: 'djvu:getPageSizes',
    renderPagePreview: 'djvu:renderPagePreview',
    estimateSizes: 'djvu:estimateSizes',
    cleanupTemp: 'djvu:cleanupTemp',
} as const;

export const DJVU_EVENT_CHANNELS = {
    progress: 'djvu:progress',
    viewingReady: 'djvu:viewingReady',
    viewingError: 'djvu:viewingError',
    menuConvertToPdf: 'menu:convertToPdf',
} as const;

export interface IDjvuInvokeMap {
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
    [DJVU_CHANNELS.cancel]: {
        args: [jobId: string];
        result: Awaited<ReturnType<IDjvuCapability['cancel']>>;
    };
    [DJVU_CHANNELS.getInfo]: {
        args: [djvuPath: string];
        result: Awaited<ReturnType<IDjvuCapability['getInfo']>>;
    };
    [DJVU_CHANNELS.getPageSizes]: {
        args: [djvuPath: string];
        result: Awaited<ReturnType<IDjvuCapability['getPageSizes']>>;
    };
    [DJVU_CHANNELS.renderPagePreview]: {
        args: [djvuPath: string, pageNumber: number];
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
}

export interface IDjvuEventMap {
    [DJVU_EVENT_CHANNELS.progress]: IDjvuProgress;
    [DJVU_EVENT_CHANNELS.viewingReady]: IDjvuViewingReadyEvent;
    [DJVU_EVENT_CHANNELS.viewingError]: IDjvuViewingErrorEvent;
    [DJVU_EVENT_CHANNELS.menuConvertToPdf]: undefined;
}
