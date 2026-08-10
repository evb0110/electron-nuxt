import type {
    IOcrErrorEnvelope,
    IOcrJobStartResult,
} from '@contracts/electronApiOcr';
import type { IOcrCapability } from '@contracts/ocrPlatformFeature';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';

const BROWSER_OCR_UNAVAILABLE = 'Browser OCR is unavailable; use the desktop app to create searchable PDFs.';

function createBrowserOcrUnavailableEnvelope(): IOcrErrorEnvelope {
    return {
        code: 'OCR_WORKER_UNAVAILABLE',
        message: BROWSER_OCR_UNAVAILABLE,
        retryable: false,
        timestamp: Date.now(),
    };
}

function createBrowserOcrJobUnavailableResult(requestId: string): IOcrJobStartResult {
    return {
        started: false,
        jobId: requestId,
        installed: [],
        error: BROWSER_OCR_UNAVAILABLE,
        errors: [BROWSER_OCR_UNAVAILABLE],
        errorEnvelope: createBrowserOcrUnavailableEnvelope(),
    };
}

export const browserOcrCapability: IOcrCapability = {
    cancel() {
        return Promise.resolve({
            canceled: false,
            reason: 'not-found',
            error: BROWSER_OCR_UNAVAILABLE,
            errorEnvelope: createBrowserOcrUnavailableEnvelope(),
        });
    },
    getLanguages() {
        return Promise.resolve([]);
    },
    resolveDocumentTextCatalog(_workingCopyPath, documentRevision, pageCount = 0) {
        return Promise.resolve({
            documentRevision,
            pageCount,
            pages: [],
            contentDigest: '',
        });
    },
    acknowledgeResultFile() {
        return Promise.resolve({
            cleaned: false,
            error: BROWSER_OCR_UNAVAILABLE,
            errorEnvelope: createBrowserOcrUnavailableEnvelope(),
        });
    },
    createSearchablePdf(_sourcePdfPath, _pages, requestId) {
        return Promise.resolve(createBrowserOcrJobUnavailableResult(requestId));
    },
    onProgress: noopUnsubscribe,
    onComplete: noopUnsubscribe,
};
