import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { IPdfBookmarkEntry } from '@contracts/pdf';
import type {
    IDjvuPdfWorkerProgressMessage,
    TDjvuPdfWorkerTask,
} from '@electron/features/djvu/main/pdfWorkerProtocol';
import {
    isFiniteWorkerMessageNumber,
    isWorkerMessageRecord,
} from '@electron/utils/workerMessage';
import {
    type IStreamingWorkerTaskHandle,
    resolveUnpackedWorkerPath,
    startStreamingWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@contracts/electronWorkerBundles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DJVU_PDF_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['djvu-pdf'].fileName;
const DJVU_PDF_WORKER_TIMEOUT_MS = 2 * 60 * 1000;

export class DjvuPdfWorkerStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DjvuPdfWorkerStartupError';
    }
}

function parseProgressMessage(message: unknown): IDjvuPdfWorkerProgressMessage | null {
    if (!isWorkerMessageRecord(message) || message.type !== 'progress') {
        return null;
    }
    if (
        message.phase !== 'buildPdf'
        || !isFiniteWorkerMessageNumber(message.page)
        || !isFiniteWorkerMessageNumber(message.total)
    ) {
        return null;
    }
    return {
        type: 'progress',
        phase: 'buildPdf',
        page: message.page,
        total: message.total,
    };
}

function isPdfWorkerResultData(value: unknown): value is number | Uint8Array | ArrayBuffer {
    return typeof value === 'number'
        || value instanceof Uint8Array
        || value instanceof ArrayBuffer;
}

function createDjvuPdfWorkerTask<T>(
    task: TDjvuPdfWorkerTask,
    options: {
        onProgress?: (message: IDjvuPdfWorkerProgressMessage) => void;
        decodeResult: (data: unknown) => T | null;
    },
): IStreamingWorkerTaskHandle<T> {
    return startStreamingWorkerTask<T>({
        workerPath: resolveUnpackedWorkerPath(__dirname, DJVU_PDF_WORKER_FILENAME),
        workerData: task,
        invalidPayloadMessage: 'DjVu PDF worker returned an invalid payload',
        invalidResultMessage: 'DjVu PDF worker returned an invalid result',
        createStartupError: (message) => new DjvuPdfWorkerStartupError(`DjVu PDF worker startup failed: ${message}`),
        createWorkerExitError: (code) => new Error(`DjVu PDF worker exited with code ${code}`),
        timeoutMs: DJVU_PDF_WORKER_TIMEOUT_MS,
        onProgressMessage: (payload) => {
            const progress = parseProgressMessage(payload);
            if (!progress) {
                return false;
            }
            options.onProgress?.(progress);
            return true;
        },
        decodeResult: (data) => {
            if (!isPdfWorkerResultData(data)) {
                return null;
            }
            return options.decodeResult(data);
        },
    });
}

export function createDjvuPdfEstimateTask(
    imagePath: string,
    dpi: number,
): IStreamingWorkerTaskHandle<number> {
    return createDjvuPdfWorkerTask({
        type: 'estimatePdfSize',
        imagePath,
        dpi,
    }, {decodeResult: (data) => (typeof data === 'number' && Number.isFinite(data) ? data : null)});
}

export function createDjvuPdfBookmarkTask(
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
): IStreamingWorkerTaskHandle<void> {
    return createDjvuPdfWorkerTask({
        type: 'embedBookmarksInFile',
        inputPdfPath,
        outputPdfPath,
        bookmarks,
    }, { decodeResult: (data) => (typeof data === 'number' && Number.isFinite(data) ? undefined : null) });
}
