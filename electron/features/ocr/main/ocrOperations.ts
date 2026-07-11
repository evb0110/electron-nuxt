import type { WebContents } from 'electron';
import { extname } from 'path';
import type {
    IOcrCancelResult,
    IOcrErrorEnvelope,
    IOcrProgress,
    IOcrRecognizeBatchResult,
    IOcrRecognizeResult,
    IOcrToolValidationResult,
} from '@contracts/electronApiOcr';
import { OCR_EVENT_CHANNELS } from '@electron/features/ocr/contract';
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
import { runOcr } from '@electron/ocr/runOcr';
import { createLogger } from '@electron/utils/createLogger';
import { resolveDocumentTextCatalogSnapshot } from '@electron/ocr/documentTextCatalog';
import { getOcrLanguageModelStates } from '@electron/ocr/languageModels';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    forEachConcurrent,
    getOcrConcurrency,
    getSequentialProgressPage,
    getTesseractThreadLimit,
} from '@electron/utils/concurrency';
import { mainJobBroker } from '@electron/resources/jobBroker';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import { requireManagedWorkingCopyPath } from '@electron/file-access/workingCopyCreation';
import { getErrorMessage } from '@electron/utils/error';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import type { IOcrOperationContext } from '@electron/features/ocr/ports';
import {
    registerOcrJobProjectionPolicy,
    getOcrJobProjection,
    subscribeOcrJobProjection,
} from '@electron/ocr/ocrJobProjection';
import {toScopedOcrJobId} from '@electron/ocr/jobManagerProtocol';

const log = createLogger('ocr-ipc');

class PlainOcrBackpressureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlainOcrBackpressureError';
    }
}

async function runBrokerAdmittedPlainOcr<T>(
    ownerId: string,
    byteCost: number,
    signal: AbortSignal,
    task: () => Promise<T>,
) {
    const lease = await mainJobBroker.acquire({
        ownerId,
        kind: 'ocr-recognition',
        priority: 'user',
        perOwnerLimit: Math.max(1, getOcrConcurrency(Number.POSITIVE_INFINITY)),
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: Math.max(16 * 1024 * 1024, byteCost * 4),
            nativeProcesses: 1,
            ioWeight: 1,
        },
        signal,
    });
    try {
        return await task();
    } finally {
        lease.release();
    }
}
const plainOcrBatchControllers = new Map<string, AbortController>();
const plainOcrProgressPumpsBySenderId = new Map<number, ReturnType<typeof createIpcProgressPump<IOcrProgress>>>();
const plainOcrProgressCleanupSenderIds = new Set<number>();

type TOcrJobManagerContext = Parameters<typeof handleOcrCreateSearchablePdfAsync>[0];
type TOcrJobManagerSender = TOcrJobManagerContext['sender'];
type TOcrSenderLifecycleListener = Parameters<TOcrJobManagerSender['once']>[1];

function toScopedPlainOcrBatchId(senderId: number, requestId: string) {
    return `${senderId}:${requestId}`;
}

function getPlainOcrProgressPump(context: IOcrOperationContext) {
    let pump = plainOcrProgressPumpsBySenderId.get(context.senderId);
    if (pump) {
        return pump;
    }

    pump = createIpcProgressPump<IOcrProgress>({
        channel: OCR_EVENT_CHANNELS.progress,
        getTarget: () => ({
            key: `web-contents:${context.senderId}`,
            isDestroyed: () => context.sender.isDestroyed(),
            send: (channel: string, payload: IOcrProgress) => safeSendToWindow(
                context.parentWindow,
                channel as typeof OCR_EVENT_CHANNELS.progress,
                payload,
            ),
        }),
        getKey: (progress: IOcrProgress) => progress.requestId,
        isTerminal: (progress: IOcrProgress) => progress.status === 'success'
            || progress.status === 'canceled'
            || progress.status === 'failed'
            || (progress.totalPages > 0 && progress.processedCount >= progress.totalPages),
        onError: (error: unknown) => {
            log.debug(`Failed to send OCR batch progress: ${getErrorMessage(error)}`);
        },
        onIdle: () => {
            plainOcrProgressPumpsBySenderId.delete(context.senderId);
        },
    });
    plainOcrProgressPumpsBySenderId.set(context.senderId, pump);

    if (!plainOcrProgressCleanupSenderIds.has(context.senderId)) {
        plainOcrProgressCleanupSenderIds.add(context.senderId);
        context.sender.once('destroyed', () => {
            plainOcrProgressPumpsBySenderId.get(context.senderId)?.dispose();
            plainOcrProgressPumpsBySenderId.delete(context.senderId);
            plainOcrProgressCleanupSenderIds.delete(context.senderId);
        });
    }

    return pump;
}

export function subscribePlainOcrProgress(context: IOcrOperationContext) {
    plainOcrProgressPumpsBySenderId.get(context.senderId)?.subscribe({
        key: `web-contents:${context.senderId}`,
        isDestroyed: () => context.sender.isDestroyed(),
        send: (channel: string, payload: IOcrProgress) => safeSendToWindow(
            context.parentWindow,
            channel as typeof OCR_EVENT_CHANNELS.progress,
            payload,
        ),
    });
}

export function handleGetOcrJobState(context: IOcrOperationContext, requestId: string) {
    return getOcrJobProjection(context.senderId, validateCancelRequestId(requestId));
}

export function handleSubscribeOcrJob(context: IOcrOperationContext, requestId: string) {
    const checkedRequestId = validateCancelRequestId(requestId);
    const unsubscribe = subscribeOcrJobProjection(context.senderId, checkedRequestId, (state) => {
        context.sender.send(OCR_EVENT_CHANNELS.progress, {
            requestId: checkedRequestId,
            currentPage: 0,
            processedCount: state.current ?? 0,
            totalPages: state.total ?? 0,
            status: state.status === 'completed'
                ? 'success'
                : state.status === 'canceled'
                    ? 'canceled'
                    : state.status === 'failed'
                        ? 'failed'
                        : 'running',
            ...(state.error ? {error: state.error} : {}),
        });
    });
    context.sender.once('destroyed', unsubscribe);
    return getOcrJobProjection(context.senderId, checkedRequestId);
}

function createOcrJobManagerContext(context: IOcrOperationContext): TOcrJobManagerContext {
    const {sender} = context;
    const once: TOcrJobManagerSender['once'] = (event, listener) => {
        if (event === 'destroyed') {
            return sender.once('destroyed', listener);
        }
        return sender.once('render-process-gone', listener);
    };
    const on: TOcrJobManagerSender['on'] = (event, listener) => sender.on(event, listener);
    const removeListener: TOcrJobManagerSender['removeListener'] = (event, listener) => {
        if (event === 'destroyed') {
            return sender.removeListener('destroyed', listener as TOcrSenderLifecycleListener);
        }
        if (event === 'render-process-gone') {
            return sender.removeListener('render-process-gone', listener as TOcrSenderLifecycleListener);
        }
        return sender.removeListener('did-start-navigation', listener);
    };

    return {
        senderId: context.senderId,
        sender: {
            isDestroyed: () => sender.isDestroyed(),
            once,
            on,
            removeListener,
        },
    };
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

export async function handleOcrRecognize(
    context: IOcrOperationContext,
    requestPayload: unknown,
): Promise<IOcrRecognizeResult> {
    let pageNumber = 0;
    const senderAbort = createSenderAbortSignal(context.sender);

    try {
        const request = validateRecognizeRequest(requestPayload);
        pageNumber = request.pageNumber;
        const imageBuffer = Buffer.from(request.imageData);
        const result = await runBrokerAdmittedPlainOcr(
            `ocr-recognize:${context.senderId}`,
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

export async function handleOcrRecognizeBatch(
    context: IOcrOperationContext,
    pagesPayload: unknown,
    requestIdPayload: unknown,
) {
    const senderAbort = createSenderAbortSignal(context.sender);
    let scopedBatchId: string | null = null;
    let registeredBatchController = false;

    try {
        const {
            pages,
            requestId,
        } = validateRecognizeBatchPayload(pagesPayload, requestIdPayload);
        scopedBatchId = toScopedPlainOcrBatchId(context.senderId, requestId);
        if (plainOcrBatchControllers.has(scopedBatchId)) {
            throw new PlainOcrBackpressureError(`OCR batch with id "${requestId}" already exists`);
        }
        plainOcrBatchControllers.set(scopedBatchId, senderAbort.controller);
        registeredBatchController = true;
        const targetPages = pages;
        const results: Record<number, string> = {};
        const errors: string[] = [];
        let firstErrorEnvelope: IOcrErrorEnvelope | undefined;
        const progressPump = getPlainOcrProgressPump(context);

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
                    const result = await runBrokerAdmittedPlainOcr(
                        `ocr-batch:${scopedBatchId}`,
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
            progressPump.clearKey(requestId);
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

export async function handleOcrGetLanguages() {
    const modelStates = new Map(
        (await getOcrLanguageModelStates()).map(item => [
            item.code,
            item.state,
        ]),
    );
    return AVAILABLE_OCR_LANGUAGES.map(language => ({
        ...language,
        modelState: modelStates.get(language.code) ?? 'missing',
    }));
}

export async function handleResolveDocumentTextCatalog(
    context: IOcrOperationContext,
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    pageCount?: number,
) {
    const resolvedPath = await validateOcrSourcePdfPath(workingCopyPath, context.senderId);
    return resolveDocumentTextCatalogSnapshot(resolvedPath, documentRevision, pageCount);
}

export async function handleOcrValidateTools() {
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

export async function handleOcrCreateSearchablePdf(
    context: IOcrOperationContext,
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
        const validatedSourcePdfPath = await validateOcrSourcePdfPath(payload.sourcePdfPath, context.senderId);
        const jobManagerContext = createOcrJobManagerContext(context);
        registerOcrJobProjectionPolicy(
            toScopedOcrJobId(context.senderId, payload.requestId),
            payload.options.supersessionPolicy ?? 'missing-only',
            payload.options.replaceAllAcknowledged === true,
        );
        const result = await handleOcrCreateSearchablePdfAsync(
            jobManagerContext,
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

export function handleOcrCancelValidated(
    context: IOcrOperationContext,
    requestIdPayload: unknown,
): IOcrCancelResult {
    try {
        const requestId = validateCancelRequestId(requestIdPayload);
        const scopedBatchId = toScopedPlainOcrBatchId(context.senderId, requestId);
        const plainBatchController = plainOcrBatchControllers.get(scopedBatchId);
        if (plainBatchController) {
            plainBatchController.abort();
            plainOcrBatchControllers.delete(scopedBatchId);
            return { canceled: true };
        }
        return handleOcrCancel(createOcrJobManagerContext(context), requestId);
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

export async function handleOcrAcknowledgeResultFileValidated(
    context: IOcrOperationContext,
    requestIdPayload: unknown,
    pdfPathPayload?: unknown,
) {
    try {
        return await handleOcrAcknowledgeResultFile(
            createOcrJobManagerContext(context),
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
