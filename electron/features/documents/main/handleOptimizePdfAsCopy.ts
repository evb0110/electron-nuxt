import {
    basename,
    extname,
} from 'path';
import { BrowserWindow } from 'electron';
import type { IPdfOptimizeOptions } from '@contracts/electronApiDocuments';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import { getWorkingCopyOriginalPath } from '@electron/file-access/workingCopyStore';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import { addRecentFile } from '@electron/recentFiles';
import { updateRecentFilesMenu } from '@electron/menu';
import { te } from '@electron/te';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import { getErrorMessage } from '@electron/utils/error';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import { createLogger } from '@electron/utils/createLogger';
import {
    DOCUMENTS_EVENT_CHANNELS,
    type TPdfOptimizeProgressPayload,
} from '@electron/features/documents/contract';
import { showSaveDialogWithExtension } from '@electron/features/documents/main/documentDialogCommon';
import {
    normalizePdfOptimizeOptions,
    optimizePdfToFile,
} from '@electron/features/documents/main/pdfOptimization';

const logger = createLogger('documents-pdfOptimization');

function getSuggestedOptimizeName(workingPath: string, senderWebContentsId: number) {
    const originalPath = getWorkingCopyOriginalPath(workingPath, senderWebContentsId)?.originalPath;
    const sourceName = originalPath ? basename(originalPath) : basename(workingPath);
    const extension = extname(sourceName).toLowerCase() || '.pdf';
    const stem = basename(sourceName, extname(sourceName));
    return `${stem}-optimized${extension === '.pdf' ? extension : '.pdf'}`;
}

function createOptimizeProgressReporter(
    event: Electron.IpcMainInvokeEvent,
    requestId: string,
) {
    const pump = createIpcProgressPump<TPdfOptimizeProgressPayload>({
        channel: DOCUMENTS_EVENT_CHANNELS.pdfOptimizeProgress,
        getTarget: () => event.sender,
        getKey: payload => payload.requestId,
        isTerminal: payload => payload.phase === 'complete',
        onError: error => {
            logger.debug(`Failed to send PDF optimize progress: ${getErrorMessage(error)}`);
        },
    });

    return (progress: TPdfOptimizeProgressPayload) => {
        if (progress.requestId === requestId) {
            pump.enqueue(progress);
        }
    };
}

export async function handleOptimizePdfAsCopy(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
    rawOptions: IPdfOptimizeOptions,
    rawRequestId?: string,
) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    const options = normalizePdfOptimizeOptions(rawOptions);
    const requestId = normalizeOptionalIpcRequestId(rawRequestId) ?? `pdf-optimize-${Date.now()}`;

    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, event.sender.id)) {
        throw new Error('Working copy path is not managed');
    }

    const targetPath = await showSaveDialogWithExtension(event, {
        title: te('dialogs.saveOptimizedPdfAs'),
        defaultPath: getSuggestedOptimizeName(normalizedWorkingPath, event.sender.id),
        filterName: te('dialogs.pdfFiles'),
        extension: 'pdf',
    });
    if (!targetPath) {
        return {
            path: null,
            validation: null,
            preset: options.preset,
            originalBytes: null,
            optimizedBytes: null,
            pageCount: null,
        };
    }

    const result = await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
        if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, event.sender.id)) {
            throw new Error('Working copy path is not managed');
        }

        return optimizePdfToFile(
            normalizedWorkingPath,
            targetPath,
            options,
            {
                requestId,
                onProgress: createOptimizeProgressReporter(event, requestId),
            },
        );
    });

    if (result.path) {
        allowOpenPath(result.path, event.sender);
        await addRecentFile(result.path);
        updateRecentFilesMenu();

        const window = BrowserWindow.fromWebContents(event.sender);
        if (window) {
            window.setRepresentedFilename?.(result.path);
        }
    }

    return result;
}
