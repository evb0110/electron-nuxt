import type { IDjvuCapability } from '@contracts/electron-api';
import { noopUnsubscribe } from '@app/platform/browser-api/common';

export const browserDjvuCapability: IDjvuCapability = {
    openForViewing(_djvuPath) {
        return Promise.resolve({
            success: false,
            error: 'DjVu viewing is not available in the browser runtime',
        });
    },
    convertToPdf(_djvuPath, _outputPath, _options) {
        return Promise.resolve({
            success: false,
            error: 'DjVu conversion is not available in the browser runtime',
        });
    },
    cancel(_jobId) {
        return Promise.resolve({ canceled: false });
    },
    getInfo(_djvuPath) {
        return Promise.reject(
            new Error('DjVu metadata is not available in the browser runtime'),
        );
    },
    estimateSizes(_djvuPath) {
        return Promise.resolve([]);
    },
    cleanupTemp(_tempPdfPath) {
        return Promise.resolve();
    },
    onProgress: noopUnsubscribe,
    onViewingReady: noopUnsubscribe,
    onViewingError: noopUnsubscribe,
    onMenuConvertToPdf: noopUnsubscribe,
};
