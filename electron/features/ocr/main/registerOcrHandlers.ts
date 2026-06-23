import type {
    IpcMainInvokeEvent,
    WebContents,
} from 'electron';
import {
    BrowserWindow,
    ipcMain,
} from 'electron';
import { extname } from 'path';
import type {
    IOcrCancelResult,
    IOcrErrorEnvelope,
    IOcrProgress,
    IOcrRecognizeBatchResult,
    IOcrRecognizeResult,
    IOcrToolValidationResult,
} from '@contracts/electronApiOcr';
import {
    OCR_CHANNELS,
    OCR_EVENT_CHANNELS,
} from '@electron/features/ocr/contract';
import {AVAILABLE_OCR_LANGUAGES} from '@electron/ocr/availableLanguages';
import {
    buildOcrErrorEnvelope,
    mapStartFailureCode,
    OcrPayloadValidationError,
    toOcrErrorEnvelope,
    validateCancelRequestId,
    validateCreateSearchablePdfPayload,
    validateRecognizeBatchPayload,
    validateRecognizeRequest,
} from '@electron/ocr/contracts';
import {
    handleOcrAcknowledgeResultFile,
    handleOcrCancel,
    handleOcrCreateSearchablePdfAsync,
    safeSendToWindow,
} from '@electron/ocr/jobManager';
import {
    getOcrToolPaths,
    validateOcrTools,
} from '@electron/ocr/paths';
import {
    handlePreprocessingValidate,
    handlePreprocessPage,
} from '@electron/ocr/preprocessingHandlers';
import { runOcr } from '@electron/ocr/runOcr';
import { createLogger } from '@electron/utils/createLogger';
import {
    forEachConcurrent,
    getOcrConcurrency,
    getSequentialProgressPage,
    getTesseractThreadLimit,
} from '@electron/utils/concurrency';
import {
    OCR_QUEUE_MAX_BUFFERED_BYTES,
    OCR_QUEUE_MAX_SIZE,
    OCR_WORKER_POOL_SIZE,
} from '@electron/ocr/jobManager.config';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import { requireManagedWorkingCopyPath } from '@electron/file-access/workingCopyCreation';
import { getErrorMessage } from '@electron/utils/error';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import type { TOcrIpcMainRegistrar } from '@electron/features/ocr/ports';

const log = createLogger('ocr-ipc');

class PlainOcrBackpressureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlainOcrBackpressureError';
    }
}

class PlainOcrLimiter {
    private activeCount = 0;
    private queuedBytes = 0;
    private readonly queue: Array<{
        byteCost: number;
        resolve: (release: () => void) => void;
        reject: (error: Error) => void;
        abortHandler: (() => void) | undefined;
        signal: AbortSignal;
    }> = [];

    async run<T>(
        byteCost: number,
        signal: AbortSignal,
        task: () => Promise<T>,
    ): Promise<T> {
        const release = await this.acquire(byteCost, signal);
        try {
            return await task();
        } finally {
            release();
        }
    }

    private acquire(byteCost: number, signal: AbortSignal): Promise<() => void> {
        if (signal.aborted) {
            return Promise.reject(new Error('Tesseract aborted'));
        }

        if (this.queue.length === 0 && this.activeCount < OCR_WORKER_POOL_SIZE) {
            return Promise.resolve(this.createLease());
        }

        if (this.queue.length >= OCR_QUEUE_MAX_SIZE) {
            return Promise.reject(new PlainOcrBackpressureError(`OCR queue is full (${OCR_QUEUE_MAX_SIZE} jobs)`));
        }
        if (this.queuedBytes + byteCost > OCR_QUEUE_MAX_BUFFERED_BYTES) {
            return Promise.reject(new PlainOcrBackpressureError(
                `OCR queued image data exceeds maximum total size (${OCR_QUEUE_MAX_BUFFERED_BYTES} bytes)`,
            ));
        }

        return new Promise<() => void>((resolve, reject) => {
            const entry = {
                byteCost,
                resolve,
                reject,
                signal,
                abortHandler: undefined as (() => void) | undefined,
            };
            entry.abortHandler = () => {
                const index = this.queue.indexOf(entry);
                if (index >= 0) {
                    this.queue.splice(index, 1);
                    this.queuedBytes -= byteCost;
                }
                reject(new Error('Tesseract aborted'));
            };
            this.queue.push(entry);
            this.queuedBytes += byteCost;
            signal.addEventListener('abort', entry.abortHandler, { once: true });
        });
    }

    private createLease() {
        this.activeCount += 1;
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.activeCount = Math.max(0, this.activeCount - 1);
            this.dispatch();
        };
    }

    private dispatch() {
        while (this.activeCount < OCR_WORKER_POOL_SIZE && this.queue.length > 0) {
            const entry = this.queue.shift();
            if (!entry) {
                return;
            }
            this.queuedBytes -= entry.byteCost;
            if (entry.abortHandler) {
                entry.signal?.removeEventListener('abort', entry.abortHandler);
            }
            if (entry.signal?.aborted) {
                entry.reject(new Error('Tesseract aborted'));
                continue;
            }
            entry.resolve(this.createLease());
        }
    }
}

const plainOcrLimiter = new PlainOcrLimiter();
const plainOcrBatchControllers = new Map<string, AbortController>();

function toScopedPlainOcrBatchId(senderId: number, requestId: string) {
    return `${senderId}:${requestId}`;
}

function toPlainOcrErrorEnvelope(error: unknown): IOcrErrorEnvelope {
    if (error instanceof PlainOcrBackpressureError) {
        return buildOcrErrorEnvelope('OCR_QUEUE_BACKPRESSURE', error.message, {retryable: true});
    }
    return toOcrErrorEnvelope(error);
}

function createPlainOcrFailureEnvelope(message: string): IOcrErrorEnvelope {
    return buildOcrErrorEnvelope('OCR_INTERNAL_ERROR', message || 'OCR failed');
}

function createSenderAbortSignal(sender: WebContents) {
    const controller = new AbortController();

    const abort = () => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    };
    const handleNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            abort();
        }
    };
    if (sender.isDestroyed()) {
        abort();
    } else {
        sender.once('destroyed', abort);
        sender.once('render-process-gone', abort);
        sender.on('did-start-navigation', handleNavigation);
    }

    const cleanup = () => {
        sender.removeListener('destroyed', abort);
        sender.removeListener('render-process-gone', abort);
        sender.removeListener('did-start-navigation', handleNavigation);
    };

    return {
        controller,
        signal: controller.signal,
        cleanup,
    };
}

async function handleOcrRecognize(
    event: IpcMainInvokeEvent,
    requestPayload: unknown,
): Promise<IOcrRecognizeResult> {
    let pageNumber = 0;
    const senderAbort = createSenderAbortSignal(event.sender);

    try {
        const request = validateRecognizeRequest(requestPayload);
        pageNumber = request.pageNumber;
        const imageBuffer = Buffer.from(request.imageData);
        const result = await plainOcrLimiter.run(
            imageBuffer.byteLength,
            senderAbort.signal,
            () => runOcr(imageBuffer, request.languages, {signal: senderAbort.signal}),
        );

        const response: IOcrRecognizeResult = {
            pageNumber: request.pageNumber,
            success: result.success,
            text: result.text,
        };
        if (typeof result.error === 'string') {
            response.error = result.error;
            if (!result.success) {
                response.errorEnvelope = createPlainOcrFailureEnvelope(result.error);
            }
        }
        return response;
    } catch (error) {
        const envelope = toPlainOcrErrorEnvelope(error);
        log.warn(`ocr:recognize failed: ${envelope.message}`);
        return {
            pageNumber,
            success: false,
            text: '',
            error: envelope.message,
            errorEnvelope: envelope,
        };
    } finally {
        senderAbort.cleanup();
    }
}

async function handleOcrRecognizeBatch(
    event: IpcMainInvokeEvent,
    pagesPayload: unknown,
    requestIdPayload: unknown,
) {
    const senderAbort = createSenderAbortSignal(event.sender);
    let scopedBatchId: string | null = null;
    let registeredBatchController = false;

    try {
        const {
            pages,
            requestId,
        } = validateRecognizeBatchPayload(pagesPayload, requestIdPayload);
        scopedBatchId = toScopedPlainOcrBatchId(event.sender.id, requestId);
        if (plainOcrBatchControllers.has(scopedBatchId)) {
            throw new PlainOcrBackpressureError(`OCR batch with id "${requestId}" already exists`);
        }
        plainOcrBatchControllers.set(scopedBatchId, senderAbort.controller);
        registeredBatchController = true;
        const targetPages = pages;
        const window = BrowserWindow.fromWebContents(event.sender);
        const results: Record<number, string> = {};
        const errors: string[] = [];
        let firstErrorEnvelope: IOcrErrorEnvelope | undefined;
        const progressPump = createIpcProgressPump<IOcrProgress>({
            channel: OCR_EVENT_CHANNELS.progress,
            getTarget: () => ({
                isDestroyed: () => event.sender.isDestroyed(),
                send: (channel, payload) => safeSendToWindow(
                    window,
                    channel as typeof OCR_EVENT_CHANNELS.progress,
                    payload,
                ),
            }),
            getKey: progress => progress.requestId,
            isTerminal: progress => progress.totalPages > 0 && progress.processedCount >= progress.totalPages,
            onError: error => {
                log.debug(`Failed to send OCR batch progress: ${getErrorMessage(error)}`);
            },
        });

        const concurrency = getOcrConcurrency(targetPages.length);
        const tesseractThreads = getTesseractThreadLimit(concurrency);

        log.debug(`OCR batch: pages=${targetPages.length}, concurrency=${concurrency}, threads=${tesseractThreads}`);

        let processedCount = 0;

        progressPump.enqueue({
            requestId,
            currentPage: targetPages[0]?.pageNumber ?? 0,
            processedCount,
            totalPages: targetPages.length,
        });

        try {
            await forEachConcurrent(targetPages, concurrency, async (page) => {
                if (senderAbort.signal.aborted) {
                    const envelope = createPlainOcrFailureEnvelope('Tesseract aborted');
                    errors.push(`Page ${page.pageNumber}: ${envelope.message}`);
                    firstErrorEnvelope ??= envelope;
                    return;
                }

                const imageBuffer = Buffer.from(page.imageData);

                try {
                    const result = await plainOcrLimiter.run(
                        imageBuffer.byteLength,
                        senderAbort.signal,
                        () => runOcr(imageBuffer, page.languages, {
                            threads: tesseractThreads,
                            signal: senderAbort.signal,
                        }),
                    );

                    if (result.success) {
                        results[page.pageNumber] = result.text;
                    } else {
                        const message = result.error ?? 'OCR failed';
                        errors.push(`Page ${page.pageNumber}: ${message}`);
                        firstErrorEnvelope ??= createPlainOcrFailureEnvelope(message);
                    }
                } catch (err) {
                    const envelope = toPlainOcrErrorEnvelope(err);
                    errors.push(`Page ${page.pageNumber}: ${envelope.message}`);
                    firstErrorEnvelope ??= envelope;
                } finally {
                    processedCount += 1;
                    progressPump.enqueue({
                        requestId,
                        currentPage: getSequentialProgressPage(targetPages, processedCount),
                        processedCount,
                        totalPages: targetPages.length,
                    });
                }
            });
        } finally {
            progressPump.clear();
        }

        const response: IOcrRecognizeBatchResult = {
            results,
            errors,
        };
        if (firstErrorEnvelope) {
            response.errorEnvelope = firstErrorEnvelope;
        }
        return response;
    } catch (error) {
        const envelope = toPlainOcrErrorEnvelope(error);
        log.warn(`ocr:recognizeBatch failed: ${envelope.message}`);
        return {
            results: {},
            errors: [envelope.message],
            errorEnvelope: envelope,
        };
    } finally {
        if (scopedBatchId !== null && registeredBatchController) {
            plainOcrBatchControllers.delete(scopedBatchId);
        }
        senderAbort.cleanup();
    }
}

function handleOcrGetLanguages() {
    return AVAILABLE_OCR_LANGUAGES;
}

async function handleOcrValidateTools() {
    try {
        return await validateOcrTools();
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error, 'OCR_TOOLS_VALIDATION_FAILED');
        const paths = getOcrToolPaths();
        log.error(`ocr:validateTools failed: ${envelope.message}`);
        const tools: IOcrToolValidationResult['tools'] = {
            tesseract: {
                found: false,
                path: paths.tesseract,
            },
            tessdata: {
                found: false,
                path: paths.tessdata,
                languages: [],
            },
            pdftoppm: {
                found: false,
                path: paths.pdftoppm,
            },
            pdftotext: {
                found: false,
                path: paths.pdftotext,
            },
            popplerRuntime: {
                dataDirFound: false,
                fontConfigDirFound: false,
            },
            qpdf: {
                found: false,
                path: paths.qpdf,
            },
        };
        if (paths.popplerDataDir !== undefined) {
            tools.popplerRuntime.dataDir = paths.popplerDataDir;
        }
        if (paths.popplerFontConfigDir !== undefined) {
            tools.popplerRuntime.fontConfigDir = paths.popplerFontConfigDir;
        }

        return {
            valid: false,
            tools,
            errors: [envelope.message],
            errorEnvelope: envelope,
        };
    }
}

async function validateOcrSourcePdfPath(sourcePdfPath: string, senderWebContentsId: number) {
    let managedSourcePdfPath: string;
    try {
        managedSourcePdfPath = await requireManagedWorkingCopyPath(sourcePdfPath, senderWebContentsId);
    } catch (error) {
        throw new OcrPayloadValidationError(`sourcePdfPath is not a managed working copy: ${getErrorMessage(error)}`);
    }
    const resolvedPath = await resolveAllowedReadPath(managedSourcePdfPath);
    if (!resolvedPath) {
        throw new OcrPayloadValidationError('sourcePdfPath must be inside the temporary working directory');
    }

    if (extname(resolvedPath).toLowerCase() !== '.pdf') {
        throw new OcrPayloadValidationError('sourcePdfPath must point to a PDF file');
    }

    return resolvedPath;
}

async function handleOcrCreateSearchablePdf(
    event: IpcMainInvokeEvent,
    sourcePdfPathPayload: unknown,
    pagesPayload: unknown,
    requestIdPayload: unknown,
    renderDpiOrOptionsPayload?: unknown,
): Promise<{
    started: boolean;
    jobId: string;
    error?: string;
    errorEnvelope?: ReturnType<typeof buildOcrErrorEnvelope>;
}> {
    let jobId = typeof requestIdPayload === 'string' ? requestIdPayload.trim() : '';

    try {
        const payload = validateCreateSearchablePdfPayload(
            sourcePdfPathPayload,
            pagesPayload,
            requestIdPayload,
            renderDpiOrOptionsPayload,
        );

        jobId = payload.requestId;
        const validatedSourcePdfPath = await validateOcrSourcePdfPath(payload.sourcePdfPath, event.sender.id);
        const result = await handleOcrCreateSearchablePdfAsync(
            event,
            validatedSourcePdfPath,
            payload.pages,
            payload.requestId,
            payload.options,
        );

        if (!result.started && result.error) {
            const {
                errorCode,
                ...publicResult
            } = result;
            return {
                ...publicResult,
                errorEnvelope: buildOcrErrorEnvelope(
                    errorCode ?? mapStartFailureCode(result.error),
                    result.error,
                    {retryable: true},
                ),
            };
        }

        return result;
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error, 'OCR_INTERNAL_ERROR', true);
        log.warn(`ocr:createSearchablePdf rejected: ${envelope.message}`);
        return {
            started: false,
            jobId,
            error: envelope.message,
            errorEnvelope: envelope,
        };
    }
}

function handleOcrCancelValidated(
    event: IpcMainInvokeEvent,
    requestIdPayload: unknown,
): IOcrCancelResult {
    try {
        const requestId = validateCancelRequestId(requestIdPayload);
        const scopedBatchId = toScopedPlainOcrBatchId(event.sender.id, requestId);
        const plainBatchController = plainOcrBatchControllers.get(scopedBatchId);
        if (plainBatchController) {
            plainBatchController.abort();
            plainOcrBatchControllers.delete(scopedBatchId);
            return { canceled: true };
        }
        return handleOcrCancel(event, requestId);
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error);
        log.warn(`ocr:cancel rejected: ${envelope.message}`);
        return {
            canceled: false,
            reason: 'invalid-request',
            error: envelope.message,
            errorEnvelope: envelope,
        };
    }
}

async function handleOcrAcknowledgeResultFileValidated(
    event: IpcMainInvokeEvent,
    requestIdPayload: unknown,
    pdfPathPayload?: unknown,
) {
    try {
        return await handleOcrAcknowledgeResultFile(
            event,
            requestIdPayload,
            pdfPathPayload,
        );
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error);
        log.warn(`ocr:ackResultFile rejected: ${envelope.message}`);
        return {
            cleaned: false,
            error: envelope.message,
            errorEnvelope: envelope,
        };
    }
}

export function registerOcrHandlers(registrar: TOcrIpcMainRegistrar = ipcMain) {
    registrar.handle(OCR_CHANNELS.recognize, handleOcrRecognize);
    registrar.handle(OCR_CHANNELS.recognizeBatch, handleOcrRecognizeBatch);
    registrar.handle(OCR_CHANNELS.createSearchablePdf, handleOcrCreateSearchablePdf);
    registrar.handle(OCR_CHANNELS.cancel, handleOcrCancelValidated);
    registrar.handle(OCR_CHANNELS.acknowledgeResultFile, handleOcrAcknowledgeResultFileValidated);
    registrar.handle(OCR_CHANNELS.getLanguages, handleOcrGetLanguages);
    registrar.handle(OCR_CHANNELS.validateTools, handleOcrValidateTools);
    registrar.handle(OCR_CHANNELS.preprocessingValidate, handlePreprocessingValidate);
    registrar.handle(OCR_CHANNELS.preprocessingPreprocessPage, handlePreprocessPage);
}
