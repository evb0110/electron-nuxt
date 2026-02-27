export const DJVU_CHANNELS = {
    openForViewing: 'djvu:openForViewing',
    convertToPdf: 'djvu:convertToPdf',
    cancel: 'djvu:cancel',
    getInfo: 'djvu:getInfo',
    estimateSizes: 'djvu:estimateSizes',
    cleanupTemp: 'djvu:cleanupTemp',
} as const;

export const DJVU_EVENT_CHANNELS = {
    progress: 'djvu:progress',
    viewingReady: 'djvu:viewingReady',
    viewingError: 'djvu:viewingError',
    menuConvertToPdf: 'menu:convertToPdf',
} as const;
