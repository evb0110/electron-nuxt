import type {
    IOcrErrorEnvelope,
    IOcrJobStartResult,
    IOcrRecognizeBatchResult,
    IOcrRecognizeResult,
    IOcrToolValidationResult,
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

function createBrowserOcrBatchUnavailableResult(): IOcrRecognizeBatchResult {
    return {
        results: {},
        errors: [BROWSER_OCR_UNAVAILABLE],
        errorEnvelope: createBrowserOcrUnavailableEnvelope(),
    };
}

export const browserOcrCapability: IOcrCapability = {
    recognize(request): Promise<IOcrRecognizeResult> {
        return Promise.resolve({
            pageNumber: request.pageNumber,
            success: false,
            text: '',
            error: BROWSER_OCR_UNAVAILABLE,
            errorEnvelope: createBrowserOcrUnavailableEnvelope(),
        });
    },
    recognizeBatch(): Promise<IOcrRecognizeBatchResult> {
        return Promise.resolve(createBrowserOcrBatchUnavailableResult());
    },
    cancel() {
        return Promise.resolve({
            canceled: false,
            reason: 'not-found',
            error: BROWSER_OCR_UNAVAILABLE,
            errorEnvelope: createBrowserOcrUnavailableEnvelope(),
        });
    },
    getJobState() {
        return Promise.resolve(null);
    },
    subscribeJob() {
        return Promise.resolve(null);
    },
    reconnectJob() {
        return Promise.resolve(null);
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
    validateTools(): Promise<IOcrToolValidationResult> {
        return Promise.resolve({
            valid: false,
            tools: {
                tesseract: {
                    found: false,
                    path: 'browser:unavailable',
                },
                tessdata: {
                    found: false,
                    path: 'browser:unavailable',
                    languages: [],
                },
                pdftoppm: {
                    found: false,
                    path: 'browser:unavailable',
                },
                pdftotext: {
                    found: false,
                    path: 'browser:unavailable',
                },
                popplerRuntime: {
                    dataDirFound: false,
                    fontConfigDirFound: false,
                },
                qpdf: {
                    found: false,
                    path: 'browser:unavailable',
                },
            },
            errors: [BROWSER_OCR_UNAVAILABLE],
            errorEnvelope: createBrowserOcrUnavailableEnvelope(),
        });
    },
    installLanguages(_languages, requestId) {
        return Promise.resolve(createBrowserOcrJobUnavailableResult(requestId));
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
    preprocessing: {
        validate() {
            return Promise.resolve({
                valid: false,
                available: [],
                missing: ['desktop-ocr'],
                errorEnvelope: createBrowserOcrUnavailableEnvelope(),
            });
        },
        preprocessPage(imageData) {
            return Promise.resolve({
                success: false,
                imageData,
                error: BROWSER_OCR_UNAVAILABLE,
                errorEnvelope: createBrowserOcrUnavailableEnvelope(),
            });
        },
    },
};
