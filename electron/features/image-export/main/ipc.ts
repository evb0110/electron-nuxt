import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { existsSync } from 'fs';
import { extname } from 'path';
import { resolveAllowedWritePath } from '@electron/utils/pathValidator';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    exportPdfAsMultiPageTiff,
    exportPdfPagesAsImages,
    getPdfPageCount,
    normalizeImageExportPath,
} from '@electron/features/image-export/main/export';
import { IMAGE_EXPORT_EVENT_CHANNELS } from '@electron/features/image-export/contract';
import { te } from '@electron/te';
import type {
    IImageExportProgress,
    TImageExportProgressStatus,
    TImageExportProgressFormat,
} from '@contracts/electronApiDocuments';
import { clamp } from 'es-toolkit/math';
import { createLogger } from '@electron/utils/createLogger';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import type { IImageExportOperationContext } from '@electron/features/image-export/ports';
import { cancelNativeCommandGroup } from '@electron/native-tools/runNativeCommand';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import type { SetOptional } from 'type-fest';
import {
    exportDjvuAsMultiPageTiff,
    exportDjvuPagesAsPng,
} from '@electron/features/image-export/main/djvuImageExport';
import { documentOutputService } from '@electron/output/documentOutputService';

const logger = createLogger('image-export');

type TImageExportProgressPayload = SetOptional<Omit<IImageExportProgress, 'format' | 'requestId'>, 'percent'>;
type TImageExportProgressPump = ReturnType<typeof createIpcProgressPump<IImageExportProgress>>;

const progressPumpsBySenderId = new Map<number, TImageExportProgressPump>();
const progressPumpSenderCleanupIds = new Set<number>();
const latestProgressBySenderId = new Map<number, Map<string, IImageExportProgress>>();
const progressSendersById = new Map<number, Electron.WebContents>();

function getImageExportProgressPump(sender: Electron.WebContents) {
    progressSendersById.set(sender.id, sender);
    let pump = progressPumpsBySenderId.get(sender.id);
    if (pump) {
        return pump;
    }

    pump = createIpcProgressPump<IImageExportProgress>({
        channel: IMAGE_EXPORT_EVENT_CHANNELS.progress,
        getTarget: () => {
            const currentSender = progressSendersById.get(sender.id);
            if (!currentSender) {
                return null;
            }
            return {
                key: `web-contents:${sender.id}`,
                isDestroyed: () => currentSender.isDestroyed(),
                send: (channel: string, payload: IImageExportProgress) => currentSender.send(channel, payload),
            };
        },
        getKey: (progress: IImageExportProgress) => progress.requestId,
        isTerminal: (progress: IImageExportProgress) => progress.status === 'success'
            || progress.status === 'canceled'
            || progress.status === 'failed'
            || progress.processed >= progress.total
            || progress.percent >= 100,
        onError: (error: unknown) => {
            logger.debug(`Failed to send image export progress update: ${String(error)}`);
        },
        onIdle: () => {
            progressPumpsBySenderId.delete(sender.id);
            latestProgressBySenderId.delete(sender.id);
            progressSendersById.delete(sender.id);
        },
    });
    progressPumpsBySenderId.set(sender.id, pump);

    if (!progressPumpSenderCleanupIds.has(sender.id)) {
        progressPumpSenderCleanupIds.add(sender.id);
        sender.once('destroyed', () => {
            progressPumpsBySenderId.get(sender.id)?.dispose();
            progressPumpsBySenderId.delete(sender.id);
            progressPumpSenderCleanupIds.delete(sender.id);
            progressSendersById.delete(sender.id);
            latestProgressBySenderId.delete(sender.id);
        });
    }

    return pump;
}

export function subscribeImageExportProgress(sender: Electron.WebContents) {
    getImageExportProgressPump(sender).subscribe({
        key: `web-contents:${sender.id}`,
        isDestroyed: () => sender.isDestroyed(),
        send: (channel: string, payload: IImageExportProgress) => sender.send(channel, payload),
    });
}

async function validateWorkingPdfPath(path: unknown, senderWebContentsId: number) {
    if (!path || typeof path !== 'string' || path.trim() === '') {
        throw new Error('Invalid working copy path');
    }

    if (!await ensureWorkingCopyDirectory(path, senderWebContentsId)) {
        throw new Error('Path is not a managed working copy');
    }

    const resolvedPath = await resolveAllowedWritePath(path);
    if (!resolvedPath) {
        throw new Error('Path is outside the allowed working directory');
    }

    if (!existsSync(resolvedPath)) {
        throw new Error(`Working copy not found: ${resolvedPath}`);
    }

    if (extname(resolvedPath).toLowerCase() !== '.pdf') {
        throw new Error('Working file must be a PDF');
    }

    return resolvedPath;
}

async function validateWorkingDjvuPath(path: unknown, senderWebContentsId: number) {
    if (!path || typeof path !== 'string' || path.trim() === '') {
        throw new Error('Invalid DjVu working copy path');
    }
    if (!await ensureWorkingCopyDirectory(path, senderWebContentsId)) {
        throw new Error('Path is not a managed working copy');
    }
    const resolvedPath = await resolveAllowedWritePath(path);
    if (!resolvedPath || !existsSync(resolvedPath)) {
        throw new Error('DjVu working copy is outside the allowed working directory');
    }
    if (!/\.djvu?$/iu.test(resolvedPath)) {
        throw new Error('Working file must be a DjVu document');
    }
    return resolvedPath;
}

function normalizeRequestedPageNumbers(pageNumbers: unknown): number[] | undefined {
    if (pageNumbers === null || pageNumbers === undefined) {
        return undefined;
    }
    if (!Array.isArray(pageNumbers)) {
        throw new Error('pageNumbers must be an array when provided');
    }

    const normalized: number[] = [];
    const seen = new Set<number>();
    for (const [
        index,
        page,
    ] of pageNumbers.entries()) {
        if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
            throw new Error(`Invalid page number at index ${index}`);
        }
        if (seen.has(page)) {
            throw new Error(`Duplicate page number: ${page}`);
        }
        seen.add(page);
        normalized.push(page);
    }

    if (normalized.length === 0) {
        throw new Error('At least one page number must be provided for scoped export');
    }

    return normalized.sort((left, right) => left - right);
}

async function validateRequestedPageNumbersWithinPdf(
    pdfPath: string,
    pageNumbers: number[] | undefined,
    operationOptions?: {
        cancelGroup?: string;
        signal?: AbortSignal;
    },
) {
    if (!pageNumbers) {
        return;
    }
    const pageCount = await getPdfPageCount(pdfPath, operationOptions);
    const outOfRangePage = pageNumbers.find(pageNumber => pageNumber > pageCount);
    if (outOfRangePage !== undefined) {
        throw new Error(`Page number ${outOfRangePage} exceeds PDF page count (${pageCount})`);
    }
}

function buildImageSuggestedName(pageNumbers: number[] | undefined) {
    if (!pageNumbers || pageNumbers.length === 0) {
        return 'document-page.jpg';
    }

    if (pageNumbers.length === 1) {
        return `document-page-${String(pageNumbers[0]).padStart(3, '0')}.jpg`;
    }

    return 'document-pages.jpg';
}

function buildMultiPageTiffSuggestedName(pageNumbers: number[] | undefined) {
    if (!pageNumbers || pageNumbers.length === 0) {
        return 'document.tiff';
    }

    if (pageNumbers.length === 1) {
        return `document-page-${String(pageNumbers[0]).padStart(3, '0')}.tiff`;
    }

    return 'document-pages.tiff';
}

function createRendererLifecycleAbortController(sender: Electron.WebContents) {
    const abortController = new AbortController();
    const abort = () => {
        abortController.abort(new Error('Renderer lifecycle ended'));
    };
    const cleanup = () => {
        sender.removeListener('destroyed', abort);
        sender.removeListener('render-process-gone', abort);
        sender.removeListener('did-start-navigation', handleNavigation);
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
        return {
            signal: abortController.signal,
            cleanup: () => {},
        };
    }

    sender.once('destroyed', abort);
    sender.once('render-process-gone', abort);
    sender.on('did-start-navigation', handleNavigation);

    return {
        signal: abortController.signal,
        cleanup,
    };
}

function createLinkedAbortSignal(
    signals: AbortSignal[],
) {
    const controller = new AbortController();
    const abort = (signal: AbortSignal) => {
        if (!controller.signal.aborted) {
            controller.abort(signal.reason instanceof Error ? signal.reason : new Error('Operation canceled'));
        }
    };
    const cleanupCallbacks: Array<() => void> = [];

    for (const signal of signals) {
        if (signal.aborted) {
            abort(signal);
            continue;
        }
        const abortHandler = () => abort(signal);
        signal.addEventListener('abort', abortHandler, { once: true });
        cleanupCallbacks.push(() => signal.removeEventListener('abort', abortHandler));
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            for (const cleanup of cleanupCallbacks.splice(0)) {
                cleanup();
            }
        },
    };
}

function isExportAborted(error: unknown) {
    return error instanceof Error
        && (
            error.name === 'AbortError'
            || error.message === 'The operation was aborted'
            || error.message === 'This operation was aborted'
            || error.message === 'Renderer lifecycle ended'
        );
}

function normalizeExportRequestId(requestId: unknown) {
    return normalizeOptionalIpcRequestId(requestId) ?? '';
}

function createImageExportProgressReporter(
    sender: Electron.WebContents,
    format: TImageExportProgressFormat,
    requestId?: string,
) {
    const normalizedRequestId = normalizeExportRequestId(requestId);
    if (!normalizedRequestId) {
        return undefined;
    }
    const progressPump = getImageExportProgressPump(sender);
    const latestProgressByRequestId = latestProgressBySenderId.get(sender.id) ?? new Map<string, IImageExportProgress>();
    latestProgressBySenderId.set(sender.id, latestProgressByRequestId);

    return (progress: TImageExportProgressPayload) => {
        const total = Math.max(1, Math.trunc(progress.total));
        const processed = clamp(Math.trunc(progress.processed), 0, total);
        const payload = {
            requestId: normalizedRequestId,
            format,
            phase: progress.phase,
            processed,
            total,
            percent: clamp(progress.percent ?? ((processed / total) * 100), 0, 100),
            status: 'running',
        } satisfies IImageExportProgress;
        latestProgressByRequestId.set(normalizedRequestId, payload);
        progressPump.enqueue(payload);
    };
}

function enqueueTerminalImageExportProgress(
    context: IImageExportOperationContext,
    requestId: string,
    format: TImageExportProgressFormat,
    status: Exclude<TImageExportProgressStatus, 'running'>,
    error?: string,
) {
    if (!requestId) {
        return;
    }
    const latest = latestProgressBySenderId.get(context.senderId)?.get(requestId);
    const payload = {
        requestId,
        format,
        phase: latest?.phase ?? (format === 'images' ? 'rendering' : 'combining'),
        processed: latest?.processed ?? 0,
        total: latest?.total ?? 0,
        percent: latest?.percent ?? 0,
        status,
        ...(error === undefined ? {} : {error}),
    } satisfies IImageExportProgress;
    latestProgressBySenderId.get(context.senderId)?.set(requestId, payload);
    getImageExportProgressPump(context.sender).enqueue(payload);
}

function clearImageExportProgress(context: IImageExportOperationContext, requestId: string) {
    if (requestId) {
        progressPumpsBySenderId.get(context.sender.id)?.clearKey(requestId);
        const latestByRequestId = latestProgressBySenderId.get(context.senderId);
        latestByRequestId?.delete(requestId);
        if (latestByRequestId && latestByRequestId.size === 0) {
            latestProgressBySenderId.delete(context.senderId);
        }
    }
}

async function showExportImageDialog(parentWindow: BrowserWindow | null, defaultName: string) {
    const dialogOptions = {
        title: te('dialogs.exportImages'),
        defaultPath: defaultName,
        filters: [
            {
                name: te('dialogs.jpegImages'),
                extensions: [
                    'jpg',
                    'jpeg',
                ],
            },
            {
                name: te('dialogs.pngImages'),
                extensions: ['png'],
            },
            {
                name: te('dialogs.tiffImages'),
                extensions: [
                    'tif',
                    'tiff',
                ],
            },
        ],
    };

    return parentWindow
        ? dialog.showSaveDialog(parentWindow, dialogOptions)
        : dialog.showSaveDialog(dialogOptions);
}

async function showMultiPageTiffDialog(parentWindow: BrowserWindow | null, defaultName: string) {
    const dialogOptions = {
        title: te('dialogs.exportMultiPageTiff'),
        defaultPath: defaultName,
        filters: [{
            name: te('dialogs.tiffImages'),
            extensions: [
                'tif',
                'tiff',
            ],
        }],
    };

    return parentWindow
        ? dialog.showSaveDialog(parentWindow, dialogOptions)
        : dialog.showSaveDialog(dialogOptions);
}

export async function handlePdfExportImages(
    context: IImageExportOperationContext,
    workingCopyPath: string,
    pageNumbers?: number[],
    requestId?: string,
    sourceKind: 'pdf' | 'djvu' = 'pdf',
): Promise<{
    success: boolean;
    canceled?: boolean;
    outputPaths?: string[];
}> {
    const normalizedRequestId = normalizeExportRequestId(requestId);
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath,
        cancel: (reason) => {
            cancelNativeCommandGroup(`image-export:${mainOperation.id}`);
            logger.warn(`Canceled image export operation ${mainOperation.id}: ${reason}`);
        },
    });
    const cancelGroup = `image-export:${mainOperation.id}`;
    const outputJob = documentOutputService.start({
        jobId: normalizedRequestId || mainOperation.id,
        operation: 'image-export',
        sourceKind,
        initialPhase: 'rendering',
    });
    const lifecycle = createRendererLifecycleAbortController(context.sender);
    const linkedAbort = createLinkedAbortSignal([
        lifecycle.signal,
        mainOperation.signal,
        outputJob.signal,
    ]);
    try {
        const normalizedWorkingCopyPath = sourceKind === 'djvu'
            ? await validateWorkingDjvuPath(workingCopyPath, context.senderId)
            : await validateWorkingPdfPath(workingCopyPath, context.senderId);
        const normalizedPageNumbers = normalizeRequestedPageNumbers(pageNumbers);
        if (sourceKind === 'pdf') {
            await validateRequestedPageNumbersWithinPdf(normalizedWorkingCopyPath, normalizedPageNumbers, {
                cancelGroup,
                signal: linkedAbort.signal,
            });
        }
        const result = await showExportImageDialog(context.parentWindow, buildImageSuggestedName(normalizedPageNumbers));
        if (result.canceled || !result.filePath || linkedAbort.signal.aborted) {
            documentOutputService.finish(outputJob.jobId, 'canceled');
            enqueueTerminalImageExportProgress(context, normalizedRequestId, 'images', 'canceled');
            return {
                success: false,
                canceled: true,
            };
        }

        const { normalizedPath } = normalizeImageExportPath(result.filePath, sourceKind === 'djvu' ? 'png' : 'jpeg');
        const reportProgress = createImageExportProgressReporter(context.sender, 'images', normalizedRequestId);
        const onProgress = (progress: TImageExportProgressPayload) => {
            reportProgress?.(progress);
            documentOutputService.update(outputJob.jobId, {
                phase: progress.phase,
                percent: progress.percent ?? (progress.processed / Math.max(1, progress.total)) * 100,
                current: progress.processed,
                total: progress.total,
            });
        };
        const exportOptions = {
            cancelGroup,
            ...(normalizedPageNumbers ? { pageNumbers: normalizedPageNumbers } : {}),
            signal: linkedAbort.signal,
            onProgress,
        };
        const outputPaths = sourceKind === 'djvu'
            ? await exportDjvuPagesAsPng(normalizedWorkingCopyPath, normalizedPath, exportOptions)
            : await exportPdfPagesAsImages(normalizedWorkingCopyPath, normalizedPath, exportOptions);
        const firstOutputPath = outputPaths[0];
        if (firstOutputPath) documentOutputService.handoff(outputJob.jobId, firstOutputPath);
        if (linkedAbort.signal.aborted) {
            documentOutputService.finish(outputJob.jobId, 'canceled');
            enqueueTerminalImageExportProgress(context, normalizedRequestId, 'images', 'canceled');
            return {
                success: false,
                canceled: true,
            };
        }

        enqueueTerminalImageExportProgress(context, normalizedRequestId, 'images', 'success');
        documentOutputService.finish(outputJob.jobId, 'completed');

        return {
            success: true,
            outputPaths,
        };
    } catch (error) {
        if (isExportAborted(error)) {
            documentOutputService.finish(outputJob.jobId, 'canceled');
            enqueueTerminalImageExportProgress(context, normalizedRequestId, 'images', 'canceled');
            return {
                success: false,
                canceled: true,
            };
        }
        enqueueTerminalImageExportProgress(context, normalizedRequestId, 'images', 'failed', error instanceof Error ? error.message : String(error));
        documentOutputService.finish(outputJob.jobId, 'failed', error instanceof Error ? error.message : String(error));
        throw error;
    } finally {
        clearImageExportProgress(context, normalizedRequestId);
        linkedAbort.cleanup();
        lifecycle.cleanup();
        mainOperation.complete();
    }
}

export async function handlePdfExportMultiPageTiff(
    context: IImageExportOperationContext,
    workingCopyPath: string,
    pageNumbers?: number[],
    requestId?: string,
    sourceKind: 'pdf' | 'djvu' = 'pdf',
): Promise<{
    success: boolean;
    canceled?: boolean;
    outputPath?: string;
    outputPaths?: string[];
}> {
    const normalizedRequestId = normalizeExportRequestId(requestId);
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath,
        cancel: (reason) => {
            cancelNativeCommandGroup(`image-export:${mainOperation.id}`);
            logger.warn(`Canceled multi-page TIFF export operation ${mainOperation.id}: ${reason}`);
        },
    });
    const cancelGroup = `image-export:${mainOperation.id}`;
    const outputJob = documentOutputService.start({
        jobId: normalizedRequestId || mainOperation.id,
        operation: 'multipage-tiff',
        sourceKind,
        initialPhase: 'rendering',
    });
    const lifecycle = createRendererLifecycleAbortController(context.sender);
    const linkedAbort = createLinkedAbortSignal([
        lifecycle.signal,
        mainOperation.signal,
        outputJob.signal,
    ]);
    try {
        const normalizedWorkingCopyPath = sourceKind === 'djvu'
            ? await validateWorkingDjvuPath(workingCopyPath, context.senderId)
            : await validateWorkingPdfPath(workingCopyPath, context.senderId);
        const normalizedPageNumbers = normalizeRequestedPageNumbers(pageNumbers);
        if (sourceKind === 'pdf') {
            await validateRequestedPageNumbersWithinPdf(normalizedWorkingCopyPath, normalizedPageNumbers, {
                cancelGroup,
                signal: linkedAbort.signal,
            });
        }
        const result = await showMultiPageTiffDialog(context.parentWindow, buildMultiPageTiffSuggestedName(normalizedPageNumbers));
        if (result.canceled || !result.filePath || linkedAbort.signal.aborted) {
            documentOutputService.finish(outputJob.jobId, 'canceled');
            enqueueTerminalImageExportProgress(context, normalizedRequestId, 'multipage-tiff', 'canceled');
            return {
                success: false,
                canceled: true,
            };
        }

        const reportProgress = createImageExportProgressReporter(context.sender, 'multipage-tiff', normalizedRequestId);
        const onProgress = (progress: TImageExportProgressPayload) => {
            reportProgress?.(progress);
            documentOutputService.update(outputJob.jobId, {
                phase: progress.phase,
                percent: progress.percent ?? (progress.processed / Math.max(1, progress.total)) * 100,
                current: progress.processed,
                total: progress.total,
            });
        };
        const exportOptions = {
            cancelGroup,
            ...(normalizedPageNumbers ? { pageNumbers: normalizedPageNumbers } : {}),
            signal: linkedAbort.signal,
            onProgress,
        };
        const outputPaths = sourceKind === 'djvu'
            ? await exportDjvuAsMultiPageTiff(normalizedWorkingCopyPath, result.filePath, exportOptions)
            : await exportPdfAsMultiPageTiff(normalizedWorkingCopyPath, result.filePath, exportOptions);
        if (linkedAbort.signal.aborted) {
            documentOutputService.finish(outputJob.jobId, 'canceled');
            enqueueTerminalImageExportProgress(context, normalizedRequestId, 'multipage-tiff', 'canceled');
            return {
                success: false,
                canceled: true,
            };
        }

        const outputPath = outputPaths[0];
        if (!outputPath) {
            throw new Error('Multi-page TIFF export did not produce an output file');
        }
        documentOutputService.handoff(outputJob.jobId, outputPath, {
            phase: 'combining',
            percent: 100,
        });

        enqueueTerminalImageExportProgress(context, normalizedRequestId, 'multipage-tiff', 'success');
        documentOutputService.finish(outputJob.jobId, 'completed');

        return {
            success: true,
            outputPath,
            outputPaths,
        };
    } catch (error) {
        if (isExportAborted(error)) {
            documentOutputService.finish(outputJob.jobId, 'canceled');
            enqueueTerminalImageExportProgress(context, normalizedRequestId, 'multipage-tiff', 'canceled');
            return {
                success: false,
                canceled: true,
            };
        }
        enqueueTerminalImageExportProgress(
            context,
            normalizedRequestId,
            'multipage-tiff',
            'failed',
            error instanceof Error ? error.message : String(error),
        );
        documentOutputService.finish(outputJob.jobId, 'failed', error instanceof Error ? error.message : String(error));
        throw error;
    } finally {
        clearImageExportProgress(context, normalizedRequestId);
        linkedAbort.cleanup();
        lifecycle.cleanup();
        mainOperation.complete();
    }
}
