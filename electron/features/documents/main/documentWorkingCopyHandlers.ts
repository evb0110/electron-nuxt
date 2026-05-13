import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import { isSupportedOpenPath } from '@electron/image/pdfConversion';
import {
    createWorkingCopyFromData,
    createWorkingCopyFromPath,
} from '@electron/ipc/workingCopyCreation';
import { isKnownWorkingCopyOriginalPath } from '@electron/ipc/workingCopyStore';
import type { TOpenPath } from '@electron/ipc/openPathCapabilities';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('documents-dialogs');

interface ITrustedOriginalPathOptions {
    sourcePath?: string;
    warningContext: string;
}

function resolveTrustedOriginalPath(
    originalPath: string | undefined,
    options: ITrustedOriginalPathOptions,
) {
    const normalizedOriginalPath = typeof originalPath === 'string' && originalPath.trim().length > 0
        ? originalPath.trim()
        : undefined;
    if (normalizedOriginalPath && (!isAbsolute(normalizedOriginalPath) || !isSupportedOpenPath(normalizedOriginalPath))) {
        throw new Error('Invalid original path');
    }

    const trustedOriginalPath = normalizedOriginalPath && (
        normalizedOriginalPath === options.sourcePath
        || isKnownWorkingCopyOriginalPath(normalizedOriginalPath)
    )
        ? normalizedOriginalPath
        : undefined;
    if (normalizedOriginalPath && !trustedOriginalPath) {
        logger.warn(`Ignoring untrusted original path for ${options.warningContext}`);
    }

    return trustedOriginalPath;
}

export async function handleCreateWorkingCopyFromData(
    _event: Electron.IpcMainInvokeEvent,
    fileName: string,
    data: Uint8Array,
    originalPath?: string,
): Promise<string> {
    const normalizedName = typeof fileName === 'string' ? fileName.trim() : '';
    if (!normalizedName) {
        throw new Error('Invalid file name');
    }
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error('Invalid PDF payload');
    }

    const trustedOriginalPath = resolveTrustedOriginalPath(originalPath, {warningContext: 'createWorkingCopyFromData'});

    return createWorkingCopyFromData(normalizedName, data, trustedOriginalPath);
}

export async function handleCreateWorkingCopyFromPath(
    _event: Electron.IpcMainInvokeEvent,
    sourcePath: TOpenPath,
    originalPath?: string,
): Promise<string> {
    if (!existsSync(sourcePath)) {
        throw new Error(`File not found: ${sourcePath}`);
    }
    if (!isSupportedOpenPath(sourcePath)) {
        throw new Error('Invalid source file type');
    }

    const trustedOriginalPath = resolveTrustedOriginalPath(originalPath, {
        sourcePath,
        warningContext: 'createWorkingCopyFromPath',
    });

    return createWorkingCopyFromPath(sourcePath, trustedOriginalPath);
}
