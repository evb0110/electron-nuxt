import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'fs';
import {
    open,
    rename,
    unlink,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { isErrnoException } from '@contracts/runtimeGuards';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('atomicReplace');

function randomSuffix() {
    return randomBytes(8).toString('hex');
}

async function fsyncPath(filePath: string) {
    const handle = await open(filePath, 'r');
    try {
        await handle.sync();
    } catch (error) {
        if (
            process.platform === 'win32'
            && isErrnoException(error)
            && (error.code === 'EPERM' || error.code === 'EINVAL')
        ) {
            logger.debug(`Skipping temp-file fsync for "${filePath}": ${getErrorMessage(error)}`);
            return;
        }

        throw error;
    } finally {
        await handle.close();
    }
}

async function fsyncParentDirectory(filePath: string) {
    if (process.platform === 'win32') {
        return;
    }

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(dirname(filePath), fsConstants.O_RDONLY);
        await handle.sync();
    } catch {
        return;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

export function makeSiblingTempPath(targetPath: string) {
    return join(dirname(targetPath), `.${randomSuffix()}.tmp`);
}

export async function atomicReplace(srcTemp: string, dst: string) {
    await fsyncPath(srcTemp);

    if (process.platform !== 'win32') {
        await rename(srcTemp, dst);
        await fsyncParentDirectory(dst);
        return;
    }

    const backupPath = `${dst}.bak-${randomSuffix()}`;
    let hasBackup = false;
    try {
        await rename(dst, backupPath);
        hasBackup = true;
    } catch (error) {
        const code = isErrnoException(error) ? error.code : undefined;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            throw error;
        }
    }

    try {
        await rename(srcTemp, dst);
    } catch (error) {
        if (hasBackup) {
            await rename(backupPath, dst).catch((restoreError) => {
                logger.error(`Failed to restore backup after atomic replace failure: ${getErrorMessage(restoreError)}`);
            });
        }
        throw error;
    }

    await fsyncParentDirectory(dst);

    if (hasBackup) {
        await unlink(backupPath).catch((error) => {
            logger.warn(`Failed to remove atomic replace backup "${backupPath}": ${getErrorMessage(error)}`);
        });
    }
}
