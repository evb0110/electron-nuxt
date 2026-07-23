/* eslint-disable @stylistic/array-bracket-newline, @stylistic/array-element-newline, @stylistic/object-curly-newline, @stylistic/object-property-newline, custom/brace-return-after-if, custom/import-specifier-newline */
import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { existsSync } from 'fs';
import { extname } from 'path';
import { resolveAllowedWritePath } from '@electron/utils/pathValidator';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {exportPdfAsMultiPageTiff, exportPdfPagesAsImages, getPdfPageCount, normalizeImageExportPath} from '@electron/features/image-export/main/export';
import { IMAGE_EXPORT_EVENT_CHANNELS } from '@electron/features/image-export/contract';
import { te } from '@electron/te';
import type {IImageExportProgress, TImageExportProgressFormat} from '@contracts/electronApiDocuments';
import { clamp } from 'es-toolkit/math';
import { createLogger } from '@electron/utils/createLogger';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import type { IImageExportOperationContext } from '@electron/features/image-export/ports';
import { cancelNativeCommandGroup } from '@electron/native-tools/runNativeCommand';
import type { SetOptional } from 'type-fest';
import {exportDjvuAsMultiPageTiff, exportDjvuPagesAsPng} from '@electron/features/image-export/main/djvuImageExport';
import {createMainJobRegistry, type IMainJobErrorEnvelope, type IMainJobRunContext} from '@electron/operation-lifecycle/createMainJobRegistry';

const logger = createLogger('image-export');

type TImageExportProgressPayload = SetOptional<Omit<IImageExportProgress, 'format' | 'requestId'>, 'percent'>;
interface IImageExportResult {success: boolean; canceled?: boolean; outputPath?: string; outputPaths?: string[];}
type TImageExportError = IMainJobErrorEnvelope<'canceled' | 'failed' | 'duplicate-job-id' | 'not-found-or-unauthorized'>;
type TImageExportJobContext = IMainJobRunContext<IImageExportProgress, IImageExportResult, TImageExportError>;

const imageExportJobs = createMainJobRegistry<IImageExportProgress, IImageExportResult, TImageExportError>({
    retention: {eventReplayTtlMs: 30_000, terminalRecordTtlMs: 30_000},
    progress: {channel: IMAGE_EXPORT_EVENT_CHANNELS.progress, getEventKey: progress => progress.requestId || null},
    toError: (cause, kind) => ({
        code: kind === 'canceled' ? 'canceled' : kind,
        message: cause instanceof Error ? cause.message : String(cause ?? 'Image export failed'),
    }),
    terminalProgress: {
        completed: latest => ({...latest, percent: 100, status: 'success'}),
        canceled: (latest, error) => ({...latest, status: 'canceled', error: error.message}),
        failed: (latest, error) => ({...latest, status: 'failed', error: error.message}),
    },
});

export function subscribeImageExportProgress(sender: Electron.WebContents) {
    imageExportJobs.subscribeOwner({sender});
}

async function validateWorkingPath(path: unknown, senderWebContentsId: number, sourceKind: 'pdf' | 'djvu') {
    if (!path || typeof path !== 'string' || path.trim() === '') throw new Error(sourceKind === 'pdf' ? 'Invalid working copy path' : 'Invalid DjVu working copy path');
    if (!await ensureWorkingCopyDirectory(path, senderWebContentsId)) throw new Error('Path is not a managed working copy');
    const resolvedPath = await resolveAllowedWritePath(path);
    if (!resolvedPath) throw new Error(sourceKind === 'pdf'
        ? 'Path is outside the allowed working directory'
        : 'DjVu working copy is outside the allowed working directory');
    if (!existsSync(resolvedPath)) throw new Error(sourceKind === 'pdf'
        ? `Working copy not found: ${resolvedPath}`
        : 'DjVu working copy is outside the allowed working directory');
    if (sourceKind === 'pdf' ? extname(resolvedPath).toLowerCase() !== '.pdf' : !/\.djvu?$/iu.test(resolvedPath)) throw new Error(sourceKind === 'pdf' ? 'Working file must be a PDF' : 'Working file must be a DjVu document');
    return resolvedPath;
}

function normalizeRequestedPageNumbers(pageNumbers: unknown): number[] | undefined {
    if (pageNumbers === null || pageNumbers === undefined) return undefined;
    if (!Array.isArray(pageNumbers)) throw new Error('pageNumbers must be an array when provided');
    const normalized: number[] = [];
    const seen = new Set<number>();
    for (const [index, page] of pageNumbers.entries()) {
        if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) throw new Error(`Invalid page number at index ${index}`);
        if (seen.has(page)) throw new Error(`Duplicate page number: ${page}`);
        seen.add(page);
        normalized.push(page);
    }
    if (normalized.length === 0) throw new Error('At least one page number must be provided for scoped export');
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
    if (!pageNumbers) return;
    const pageCount = await getPdfPageCount(pdfPath, operationOptions);
    const outOfRangePage = pageNumbers.find(pageNumber => pageNumber > pageCount);
    if (outOfRangePage !== undefined) throw new Error(`Page number ${outOfRangePage} exceeds PDF page count (${pageCount})`);
}

function buildSuggestedName(pageNumbers: number[] | undefined, format: TImageExportProgressFormat) {
    const extension = format === 'images' ? 'jpg' : 'tiff';
    if (!pageNumbers || pageNumbers.length === 0) return format === 'images' ? 'document-page.jpg' : 'document.tiff';
    if (pageNumbers.length === 1) return `document-page-${String(pageNumbers[0]).padStart(3, '0')}.${extension}`;
    return format === 'images' ? 'document-pages.jpg' : 'document-pages.tiff';
}

function normalizeExportRequestId(requestId: unknown) {
    return normalizeOptionalIpcRequestId(requestId) ?? '';
}

async function runImageExportJob(
    context: IImageExportOperationContext, workingCopyPath: string, requestId: string | undefined, format: TImageExportProgressFormat,
    run: (
        job: TImageExportJobContext,
        cancelGroup: string,
        reportProgress: (progress: TImageExportProgressPayload) => void,
    ) => Promise<IImageExportResult>,
) {
    const normalizedRequestId = normalizeExportRequestId(requestId);
    const handle = imageExportJobs.start({
        ...(normalizedRequestId ? {jobId: normalizedRequestId} : {}),
        owner: {sender: context.sender},
        operation: {kind: 'abortable-work', workingCopyPath},
        initialProgress: {
            requestId: normalizedRequestId,
            format,
            phase: format === 'images' ? 'rendering' : 'combining',
            processed: 0,
            total: 0,
            percent: 0,
            status: 'running',
        },
        ownerLifecycle: {destroyed: 'cancel', renderProcessGone: 'cancel', mainFrameNavigation: 'cancel'},
        onCancel: (reason) => {
            cancelNativeCommandGroup(`image-export:${handle.jobId}`);
            logger.warn(`Canceled image export operation ${handle.jobId}: ${reason}`);
        },
        run: async job => run(job, `image-export:${job.jobId}`, progress => {
            const total = Math.max(1, Math.trunc(progress.total));
            const processed = clamp(Math.trunc(progress.processed), 0, total);
            job.publish({
                requestId: normalizedRequestId,
                format,
                phase: progress.phase,
                processed,
                total,
                percent: clamp(progress.percent ?? ((processed / total) * 100), 0, 100),
                status: 'running',
            });
        }),
    });
    const terminal = await handle.terminal;
    await handle.settled;
    if (terminal.status === 'completed') return terminal.result;
    if (terminal.status === 'canceled') return {success: false, canceled: true};
    throw new Error(terminal.error.message);
}

async function showImageExportDialog(parentWindow: BrowserWindow | null, defaultName: string, format: TImageExportProgressFormat) {
    const tiffFilter = {
        name: te('dialogs.tiffImages'),
        extensions: [
            'tif',
            'tiff',
        ],
    };
    const dialogOptions = {
        title: te(format === 'images' ? 'dialogs.exportImages' : 'dialogs.exportMultiPageTiff'),
        defaultPath: defaultName,
        filters: format === 'images' ? [
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
            tiffFilter,
        ] : [tiffFilter],
    };

    return parentWindow ? dialog.showSaveDialog(parentWindow, dialogOptions) : dialog.showSaveDialog(dialogOptions);
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
    return runImageExportJob(context, workingCopyPath, requestId, 'images', async (
        job,
        cancelGroup,
        reportProgress,
    ) => {
        const normalizedWorkingCopyPath = await validateWorkingPath(workingCopyPath, context.senderId, sourceKind);
        const normalizedPageNumbers = normalizeRequestedPageNumbers(pageNumbers);
        if (sourceKind === 'pdf') {
            await validateRequestedPageNumbersWithinPdf(normalizedWorkingCopyPath, normalizedPageNumbers, {
                cancelGroup,
                signal: job.signal,
            });
        }
        const result = await showImageExportDialog(
            context.parentWindow,
            buildSuggestedName(normalizedPageNumbers, 'images'),
            'images',
        );
        if (result.canceled || !result.filePath || job.signal.aborted) {
            job.terminal.cancel(new Error('Image export canceled'));
            return {
                success: false,
                canceled: true,
            };
        }

        const { normalizedPath } = normalizeImageExportPath(result.filePath, sourceKind === 'djvu' ? 'png' : 'jpeg');
        const exportOptions = {
            cancelGroup,
            ...(normalizedPageNumbers ? { pageNumbers: normalizedPageNumbers } : {}),
            signal: job.signal,
            scratch: job.scratch,
            onProgress: reportProgress,
        };
        const outputPaths = sourceKind === 'djvu'
            ? await exportDjvuPagesAsPng(normalizedWorkingCopyPath, normalizedPath, exportOptions)
            : await exportPdfPagesAsImages(normalizedWorkingCopyPath, normalizedPath, exportOptions);
        if (job.signal.aborted) {
            job.terminal.cancel(job.signal.reason);
            return {
                success: false,
                canceled: true,
            };
        }
        const exportResult = {
            success: true,
            outputPaths,
        };
        job.handoff(exportResult);
        return exportResult;
    });
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
    return runImageExportJob(context, workingCopyPath, requestId, 'multipage-tiff', async (
        job,
        cancelGroup,
        reportProgress,
    ) => {
        const normalizedWorkingCopyPath = await validateWorkingPath(workingCopyPath, context.senderId, sourceKind);
        const normalizedPageNumbers = normalizeRequestedPageNumbers(pageNumbers);
        if (sourceKind === 'pdf') {
            await validateRequestedPageNumbersWithinPdf(normalizedWorkingCopyPath, normalizedPageNumbers, {
                cancelGroup,
                signal: job.signal,
            });
        }
        const result = await showImageExportDialog(
            context.parentWindow,
            buildSuggestedName(normalizedPageNumbers, 'multipage-tiff'),
            'multipage-tiff',
        );
        if (result.canceled || !result.filePath || job.signal.aborted) {
            job.terminal.cancel(new Error('Image export canceled'));
            return {
                success: false,
                canceled: true,
            };
        }

        const exportOptions = {
            cancelGroup,
            ...(normalizedPageNumbers ? { pageNumbers: normalizedPageNumbers } : {}),
            signal: job.signal,
            scratch: job.scratch,
            onProgress: reportProgress,
        };
        const outputPaths = sourceKind === 'djvu'
            ? await exportDjvuAsMultiPageTiff(normalizedWorkingCopyPath, result.filePath, exportOptions)
            : await exportPdfAsMultiPageTiff(normalizedWorkingCopyPath, result.filePath, exportOptions);
        if (job.signal.aborted) {
            job.terminal.cancel(job.signal.reason);
            return {
                success: false,
                canceled: true,
            };
        }

        const outputPath = outputPaths[0];
        if (!outputPath) {
            throw new Error('Multi-page TIFF export did not produce an output file');
        }
        const exportResult = {
            success: true,
            outputPath,
            outputPaths,
        };
        job.handoff(exportResult);
        return exportResult;
    });
}
