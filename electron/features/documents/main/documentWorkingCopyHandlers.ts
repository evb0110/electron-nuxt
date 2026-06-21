import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import { isSupportedOpenPath } from '@electron/image/pdfConversion';
import {
    createWorkingCopyFromData,
    createWorkingCopyFromPath,
} from '@electron/file-access/workingCopyCreation';
import { isKnownWorkingCopyOriginalPath } from '@electron/file-access/workingCopyStore';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import { createLogger } from '@electron/utils/createLogger';
import { IPC_FILENAME_MAX_LENGTH } from '@electron/utils/ipcLimits';

const logger = createLogger('documents-dialogs');
const MAX_WORKING_COPY_DATA_BYTES = 512 * 1024 * 1024;

interface ITrustedOriginalPathOptions {
    sourcePath?: string;
    warningContext: string;
}

function resolveTrustedOriginalPath(
    originalPath: string | undefined,
    options: ITrustedOriginalPathOptions,
    senderWebContentsId?: number,
) {
    const normalizedOriginalPath = typeof originalPath === 'string' && originalPath.trim().length > 0
        ? originalPath.trim()
        : undefined;
    if (normalizedOriginalPath && (!isAbsolute(normalizedOriginalPath) || !isSupportedOpenPath(normalizedOriginalPath))) {
        throw new Error('Invalid original path');
    }

    const trustedOriginalPath = normalizedOriginalPath && (
        normalizedOriginalPath === options.sourcePath
        || isKnownWorkingCopyOriginalPath(normalizedOriginalPath, senderWebContentsId)
    )
        ? normalizedOriginalPath
        : undefined;
    if (normalizedOriginalPath && !trustedOriginalPath) {
        logger.warn(`Ignoring untrusted original path for ${options.warningContext}`);
    }

    return trustedOriginalPath;
}

export async function handleCreateWorkingCopyFromData(
    event: Electron.IpcMainInvokeEvent,
    fileName: string,
    data: Uint8Array,
    originalPath?: string,
) {
    const normalizedName = typeof fileName === 'string' ? fileName.trim() : '';
    if (!normalizedName || normalizedName.length > IPC_FILENAME_MAX_LENGTH) {
        throw new Error('Invalid file name');
    }
    if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > MAX_WORKING_COPY_DATA_BYTES) {
        throw new Error('Invalid PDF payload');
    }

    const trustedOriginalPath = resolveTrustedOriginalPath(
        originalPath,
        {warningContext: 'createWorkingCopyFromData'},
        event.sender.id,
    );

    return createWorkingCopyFromData(normalizedName, data, trustedOriginalPath, event.sender.id);
}

export async function handleCreateWorkingCopyFromPath(
    event: Electron.IpcMainInvokeEvent,
    sourcePath: TOpenPath,
    originalPath?: string,
) {
    if (!existsSync(sourcePath)) {
        throw new Error(`File not found: ${sourcePath}`);
    }
    if (!isSupportedOpenPath(sourcePath)) {
        throw new Error('Invalid source file type');
    }

    const trustedOriginalPath = resolveTrustedOriginalPath(originalPath, {
        sourcePath,
        warningContext: 'createWorkingCopyFromPath',
    }, event.sender.id);

    return createWorkingCopyFromPath(sourcePath, trustedOriginalPath, event.sender.id);
}
