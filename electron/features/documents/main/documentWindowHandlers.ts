import {
    BrowserWindow,
    shell,
} from 'electron';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { refreshMenu } from '@electron/menu';
import {
    requireOpenPath,
    type TOpenPath,
} from '@electron/ipc/openPathCapabilities';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import { isKnownWorkingCopyOriginalPath } from '@electron/ipc/workingCopyStore';
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('documents-dialogs');
type TOpenPathOwner = number | Electron.WebContents;

export function handleSetWindowTitle(event: Electron.IpcMainInvokeEvent, title: string) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        const normalizedTitle = typeof title === 'string' ? title : '';
        window.setTitle(normalizedTitle || te('app.title'));
        refreshMenu();
    }
}

async function resolveRevealablePath(filePath: string, owner?: TOpenPathOwner) {
    const resolvedReadPath = await resolveAllowedReadPath(filePath);
    if (resolvedReadPath) {
        return resolvedReadPath;
    }

    const allowedRevealPath = (() => {
        try {
            return requireOpenPath(resolve(filePath), owner);
        } catch {
            return null;
        }
    })();
    if (allowedRevealPath && existsSync(allowedRevealPath)) {
        return allowedRevealPath;
    }

    const normalizedPath = resolve(filePath);
    const ownerId = typeof owner === 'number' ? owner : owner?.id;
    if (!isKnownWorkingCopyOriginalPath(normalizedPath, ownerId) || !existsSync(normalizedPath)) {
        return null;
    }
    return normalizedPath as TOpenPath;
}

export async function handleShowItemInFolder(
    event: Electron.IpcMainInvokeEvent,
    filePath: string,
): Promise<boolean> {
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!normalizedPath) {
        return false;
    }

    try {
        const revealablePath = await resolveRevealablePath(normalizedPath, event.sender);
        if (!revealablePath) {
            return false;
        }
        shell.showItemInFolder(revealablePath);
        return true;
    } catch (error) {
        logger.error(`Failed to show item in folder: ${getErrorMessage(error)}`);
        return false;
    }
}
