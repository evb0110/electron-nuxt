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
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('atomic-replace');

function randomSuffix() {
    return randomBytes(8).toString('hex');
}

async function fsyncPath(filePath: string) {
    const handle = await open(filePath, 'r');
    try {
        await handle.sync();
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EINVAL')) {
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

export async function atomicReplace(srcTemp: string, dst: string): Promise<void> {
    await fsyncPath(srcTemp);

    const backupPath = `${dst}.bak-${randomSuffix()}`;
    let hasBackup = false;
    try {
        await rename(dst, backupPath);
        hasBackup = true;
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
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
