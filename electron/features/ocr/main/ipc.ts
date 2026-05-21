import type {
    IpcMain,
    IpcMainInvokeEvent,
    WebContents,
} from 'electron';
import {
    BrowserWindow,
    ipcMain,
} from 'electron';
import { extname } from 'path';
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
import { runOcr } from '@electron/ocr/tesseract';
import { createLogger } from '@electron/utils/logger';
import {
    forEachConcurrent,
    getOcrConcurrency,
    getSequentialProgressPage,
    getTesseractThreadLimit,
} from '@electron/utils/concurrency';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import { requireManagedWorkingCopyPath } from '@electron/ipc/workingCopyCreation';
import { getErrorMessage } from '@electron/utils/error';

const log = createLogger('ocr-ipc');

function createSenderAbortSignal(sender: WebContents) {
    const controller = new AbortController();

    const abort = () => {
        controller.abort();
    };
    if (sender.isDestroyed()) {
        abort();
    } else {
        sender.once('destroyed', abort);
        sender.once('render-process-gone', abort);
    }

    const cleanup = () => {
        sender.removeListener('destroyed', abort);
        sender.removeListener('render-process-gone', abort);
    };

    return {
        signal: controller.signal,
        cleanup,
    };
}

async function handleOcrRecognize(
    event: IpcMainInvokeEvent,
    requestPayload: unknown,
) {
    let pageNumber = 0;
    const senderAbort = createSenderAbortSignal(event.sender);

    try {
        const request = validateRecognizeRequest(requestPayload);
        pageNumber = request.pageNumber;
        const imageBuffer = Buffer.from(request.imageData);
        const result = await runOcr(imageBuffer, request.languages, {signal: senderAbort.signal});

        return {
            pageNumber: request.pageNumber,
            success: result.success,
            text: result.text,
            error: result.error,
        };
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error);
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

    try {
        const {
            pages,
            requestId,
        } = validateRecognizeBatchPayload(pagesPayload, requestIdPayload);
        const targetPages = pages;
        const window = BrowserWindow.fromWebContents(event.sender);
        const results: Record<number, string> = {};
        const errors: string[] = [];

        const concurrency = getOcrConcurrency(targetPages.length);
        const tesseractThreads = getTesseractThreadLimit(concurrency);

        log.debug(`OCR batch: pages=${targetPages.length}, concurrency=${concurrency}, threads=${tesseractThreads}`);

        let processedCount = 0;

        safeSendToWindow(window, OCR_EVENT_CHANNELS.progress, {
            requestId,
            currentPage: targetPages[0]?.pageNumber ?? 0,
            processedCount,
            totalPages: targetPages.length,
        });

        await forEachConcurrent(targetPages, concurrency, async (page) => {
            if (senderAbort.signal.aborted) {
                errors.push(`Page ${page.pageNumber}: Tesseract aborted`);
                return;
            }

            const imageBuffer = Buffer.from(page.imageData);

            try {
                const result = await runOcr(imageBuffer, page.languages, {
                    threads: tesseractThreads,
                    signal: senderAbort.signal,
                });

                if (result.success) {
                    results[page.pageNumber] = result.text;
                } else {
                    errors.push(`Page ${page.pageNumber}: ${result.error}`);
                }
            } catch (err) {
                const errMsg = getErrorMessage(err);
                errors.push(`Page ${page.pageNumber}: ${errMsg}`);
            } finally {
                processedCount += 1;
                safeSendToWindow(window, OCR_EVENT_CHANNELS.progress, {
                    requestId,
                    currentPage: getSequentialProgressPage(targetPages, processedCount),
                    processedCount,
                    totalPages: targetPages.length,
                });
            }
        });

        return {
            results,
            errors,
        };
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error);
        log.warn(`ocr:recognizeBatch failed: ${envelope.message}`);
        return {
            results: {},
            errors: [envelope.message],
            errorEnvelope: envelope,
        };
    } finally {
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
        return {
            valid: false,
            tools: {
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
                    dataDir: paths.popplerDataDir,
                    fontConfigDirFound: false,
                    fontConfigDir: paths.popplerFontConfigDir,
                },
                qpdf: {
                    found: false,
                    path: paths.qpdf,
                },
            },
            errors: [envelope.message],
            errorEnvelope: envelope,
        };
    }
}

async function validateOcrSourcePdfPath(sourcePdfPath: string, senderWebContentsId: number): Promise<string> {
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
    renderDpiPayload?: unknown,
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
            renderDpiPayload,
        );

        jobId = payload.requestId;
        const validatedSourcePdfPath = await validateOcrSourcePdfPath(payload.sourcePdfPath, event.sender.id);
        const result = await handleOcrCreateSearchablePdfAsync(
            event,
            validatedSourcePdfPath,
            payload.pages,
            payload.requestId,
            payload.renderDpi,
        );

        if (!result.started && result.error) {
            return {
                ...result,
                errorEnvelope: buildOcrErrorEnvelope(
                    mapStartFailureCode(result.error),
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
): {
    canceled: boolean;
    errorEnvelope?: ReturnType<typeof buildOcrErrorEnvelope>;
} {
    try {
        const requestId = validateCancelRequestId(requestIdPayload);
        return handleOcrCancel(event, requestId);
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error);
        log.warn(`ocr:cancel rejected: ${envelope.message}`);
        return {
            canceled: false,
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

interface IIpcMainHandleRegistrar {handle: IpcMain['handle'];}

export function registerOcrHandlers(registrar: IIpcMainHandleRegistrar = ipcMain) {
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
