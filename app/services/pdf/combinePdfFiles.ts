import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { hasElectronAPI } from '@app/utils/platform';
import {
    getDocumentMenuCapability,
    getDocumentOpenCapability,
    getDocumentPickerCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import { getErrorMessage } from '@app/utils/error';
import { BrowserLogger } from '@app/utils/browserLogger';

export type TCombinePdfErrorCode = 'canceled' | 'invalid-input' | 'limit' | 'unsupported' | 'open-failed';

export class CombinePdfError extends Error {
    public constructor(public readonly code: TCombinePdfErrorCode, options?: {cause?: unknown}) {
        super(`PDF combine failed (${code})`, options);
        this.name = 'CombinePdfError';
    }
}

function classifyCombineError(error: unknown): TCombinePdfErrorCode {
    if (error instanceof DOMException && error.name === 'AbortError') {
        return 'canceled';
    }
    const message = getErrorMessage(error).toLowerCase();
    if (message.includes('cancel') || message.includes('abort')) {
        return 'canceled';
    }
    if (message.includes('limit') || message.includes('too large') || message.includes('too many') || message.includes('capped')) {
        return 'limit';
    }
    if (message.includes('unsupported') || message.includes('unreadable')) {
        return 'unsupported';
    }
    if (message.includes('invalid') || message.includes('no input')) {
        return 'invalid-input';
    }
    return 'open-failed';
}

export interface ICombinePdfInputFile {file: File;}

export interface ICombinePdfCapabilities {
    supportedExtensions: readonly string[];
    maxInputs: number;
    maxInputBytes: number;
    maxTotalInputBytes: number;
}

const COMBINE_PDF_EXTENSIONS = [
    '.pdf',
    '.djvu',
    '.djv',
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
] as const;

export function getCombinePdfCapabilities(): ICombinePdfCapabilities {
    return hasElectronAPI() ? {
        supportedExtensions: COMBINE_PDF_EXTENSIONS,
        maxInputs: 512,
        maxInputBytes: 512 * 1024 * 1024,
        maxTotalInputBytes: 1024 * 1024 * 1024,
    } : {
        supportedExtensions: COMBINE_PDF_EXTENSIONS,
        maxInputs: 500,
        maxInputBytes: 32 * 1024 * 1024,
        maxTotalInputBytes: 64 * 1024 * 1024,
    };
}

function assertCombineInputsWithinCapabilities(options: ICombinePdfFilesOptions) {
    const capabilities = getCombinePdfCapabilities();
    if (options.files.length === 0 || options.files.length > capabilities.maxInputs) {
        throw new CombinePdfError('limit');
    }
    let totalBytes = 0;
    for (const {file} of options.files) {
        if (file.size <= 0 || file.size > capabilities.maxInputBytes) {
            throw new CombinePdfError(file.size <= 0 ? 'invalid-input' : 'limit');
        }
        totalBytes += file.size;
    }
    if (totalBytes > capabilities.maxTotalInputBytes) {
        throw new CombinePdfError('limit');
    }
}

export interface ICombinePdfProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

export interface ICombinePdfFilesOptions {
    files: readonly ICombinePdfInputFile[];
    outputName: string;
    openErrorMessage: string;
    onProgress?: (progress: ICombinePdfProgress) => void;
    signal?: AbortSignal;
}

function emitCompleteProgress(
    options: ICombinePdfFilesOptions,
    previousProgress?: ICombinePdfProgress | null,
) {
    options.onProgress?.({
        processed: options.files.length,
        total: options.files.length,
        percent: 100,
        elapsedMs: previousProgress?.elapsedMs ?? 0,
        estimatedRemainingMs: null,
    });
}

function toMonotonicInProgress(
    next: ICombinePdfProgress,
    previous: ICombinePdfProgress | null,
) {
    return {
        ...next,
        processed: Math.max(previous?.processed ?? 0, next.processed),
        percent: Math.min(95, Math.max(previous?.percent ?? 0, next.percent)),
        elapsedMs: Math.max(previous?.elapsedMs ?? 0, next.elapsedMs),
    };
}

async function combineElectronFiles(options: ICombinePdfFilesOptions): Promise<TOpenFileResult> {
    const documentPicker = getDocumentPickerCapability();
    const documentOpen = getDocumentOpenCapability();
    const documentMenu = getDocumentMenuCapability();
    const inputPaths = documentPicker.getPathsForFiles(options.files.map(entry => entry.file))
        .filter(path => path.length > 0);

    if (inputPaths.length !== options.files.length) {
        throw new Error(options.openErrorMessage);
    }

    const requestId = crypto.randomUUID();
    let latestProgress: ICombinePdfProgress | null = null;
    const stopProgress = documentMenu.onOpenDocumentDirectBatchProgress((nextProgress) => {
        if (
            nextProgress.operation !== 'document-open'
            || nextProgress.requestId !== requestId
        ) {
            return;
        }

        latestProgress = toMonotonicInProgress({
            processed: nextProgress.processed,
            total: nextProgress.total,
            percent: nextProgress.percent,
            elapsedMs: nextProgress.elapsedMs,
            estimatedRemainingMs: nextProgress.estimatedRemainingMs,
        }, latestProgress);
        options.onProgress?.(latestProgress);
    });
    const abort = () => {
        void documentOpen.cancelOpenDocumentDirectBatch?.(requestId).catch(() => undefined);
    };
    options.signal?.addEventListener('abort', abort, {once: true});

    try {
        const result = await documentOpen.openDocumentDirectBatch(inputPaths, requestId, {forceCombine: true});
        if (!result) {
            throw new Error(options.openErrorMessage);
        }

        emitCompleteProgress(options, latestProgress);
        return result;
    } finally {
        options.signal?.removeEventListener('abort', abort);
        stopProgress();
    }
}

async function combineBrowserFiles(options: ICombinePdfFilesOptions): Promise<TOpenFileResult> {
    let latestProgress: ICombinePdfProgress | null = null;
    const documentPicker = getDocumentPickerCapability();
    if (!documentPicker.createCombinedPdfFromFiles) {
        throw new Error(options.openErrorMessage);
    }

    const combinedPdf = await documentPicker.createCombinedPdfFromFiles(
        options.files.map(entry => entry.file),
        {
            onProgress: (nextProgress) => {
                latestProgress = toMonotonicInProgress(nextProgress, latestProgress);
                options.onProgress?.(latestProgress);
            },
            ...(options.signal ? {signal: options.signal} : {}),
        },
    );
    const workingPath = await getDocumentWorkingCopyCapability().createWorkingCopyFromData(
        options.outputName,
        combinedPdf,
    );
    emitCompleteProgress(options, latestProgress);
    return {
        kind: 'pdf',
        workingPath,
        originalPath: workingPath,
        isGenerated: true,
    };
}

export async function combinePdfFiles(options: ICombinePdfFilesOptions): Promise<TOpenFileResult> {
    assertCombineInputsWithinCapabilities(options);
    if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new DOMException('PDF combine was canceled.', 'AbortError');
    }
    try {
        return await (hasElectronAPI()
            ? combineElectronFiles(options)
            : combineBrowserFiles(options));
    } catch (error) {
        if (error instanceof CombinePdfError) throw error;
        const code = classifyCombineError(error);
        BrowserLogger.error('pdf-combine', 'PDF combine operation failed', {
            code,
            detail: getErrorMessage(error),
        });
        throw new CombinePdfError(code, {cause: error});
    }
}
