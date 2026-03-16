import type { IOcrCapability } from '@contracts/electron-api';
import { noopUnsubscribe } from '@app/platform/browser-api/common';

export const browserOcrCapability: IOcrCapability = {
    recognize(request) {
        return Promise.resolve({
            pageNumber: request.pageNumber,
            success: false,
            text: '',
            error: 'OCR is not available in the browser runtime',
        });
    },
    recognizeBatch(_pages, _requestId) {
        return Promise.resolve({
            results: {},
            errors: ['OCR is not available in the browser runtime'],
        });
    },
    cancel(_requestId) {
        return Promise.resolve({ canceled: false });
    },
    getLanguages() {
        return Promise.resolve([]);
    },
    acknowledgeResultFile(_requestId, _pdfPath) {
        return Promise.resolve({ cleaned: true });
    },
    createSearchablePdf(_sourcePdfPath, _pages, _requestId, _renderDpi) {
        return Promise.resolve({
            started: false,
            jobId: '',
            error: 'OCR is not available in the browser runtime',
        });
    },
    onProgress: noopUnsubscribe,
    onComplete: noopUnsubscribe,
    preprocessing: {
        validate() {
            return Promise.resolve({
                valid: false,
                available: [],
                missing: ['browser-ocr'],
            });
        },
        preprocessPage(imageData) {
            return Promise.resolve({
                success: true,
                imageData,
            });
        },
    },
};
