import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'fs';
import {
    copyFile,
    open,
    rename,
    stat,
    unlink,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { isErrnoException } from '@contracts/runtimeGuards';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { syncFileHandleForDurability } from '@electron/utils/syncFileHandleForDurability';
import { markActiveWorkingCopyMutationCommitStarted } from '@electron/file-access/workingCopyMutationCommitSignal';

const logger = createLogger('atomicReplace');

function randomSuffix() {
    return randomBytes(8).toString('hex');
}

async function fsyncPath(filePath: string) {
    const handle = await open(filePath, 'r');
    try {
        await syncFileHandleForDurability(handle, {onSkipped: error => logger.debug(
            `Skipping temp-file fsync for "${filePath}": ${getErrorMessage(error)}`,
        )});
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

async function pathExists(filePath: string) {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

async function assertPathExists(filePath: string, context: string) {
    if (await pathExists(filePath)) {
        return;
    }

    throw new Error(`${context}: destination "${filePath}" is missing after atomic replace`);
}

async function createRestoreFailureError(
    dst: string,
    backupPath: string,
    promotionError: unknown,
    restoreError: unknown,
) {
    const [
        dstExists,
        backupExists,
    ] = await Promise.all([
        pathExists(dst),
        pathExists(backupPath),
    ]);
    return new Error(
        `Atomic replace failed and backup restore failed for "${dst}". `
        + `Promotion error: ${getErrorMessage(promotionError)}. `
        + `Restore error: ${getErrorMessage(restoreError)}. `
        + `Backup path: "${backupPath}" (exists: ${backupExists ? 'yes' : 'no'}). `
        + `Destination exists: ${dstExists ? 'yes' : 'no'}.`,
    );
}

export function makeSiblingTempPath(targetPath: string) {
    return join(dirname(targetPath), `.${randomSuffix()}.tmp`);
}

export async function atomicReplace(
    srcTemp: string,
    dst: string,
    options: {
        /**
         * Whether the replacement has to survive a crash. A within-run cache
         * publishes into a scratch directory that is discarded when the process
         * exits, so it takes the same replace semantics — a reader of the
         * destination keeps reading a complete file, and Windows never fails
         * the rename against an open handle — without paying for two fsyncs it
         * has nothing to recover.
         */
        durable?: boolean;
        markMutationCommitStarted?: boolean;
    } = {},
) {
    const durable = options.durable !== false;
    if (durable) {
        await fsyncPath(srcTemp);
    }
    if (options.markMutationCommitStarted !== false) {
        markActiveWorkingCopyMutationCommitStarted();
    }

    if (
        process.env.EVB_DOCUMENT_RECOVERY_COPY === '1'
        && /\.(?:pdf|djvu?|tiff?)$/iu.test(dst)
        && await pathExists(dst)
    ) {
        const recoveryTempPath = `${dst}.evb-recovery.tmp`;
        const recoveryPath = `${dst}.evb-recovery`;
        await copyFile(dst, recoveryTempPath);
        await fsyncPath(recoveryTempPath);
        await rename(recoveryTempPath, recoveryPath);
        await fsyncParentDirectory(recoveryPath);
    }

    if (process.platform !== 'win32') {
        await rename(srcTemp, dst);
        if (durable) {
            await fsyncParentDirectory(dst);
        }
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
            await rename(backupPath, dst).catch(async (restoreError) => {
                logger.error(`Failed to restore backup after atomic replace failure: ${getErrorMessage(restoreError)}`);
                throw await createRestoreFailureError(dst, backupPath, error, restoreError);
            });
            await assertPathExists(dst, 'Atomic replace failed after restoring backup');
        }
        throw error;
    }

    await assertPathExists(dst, 'Atomic replace completed');
    await fsyncParentDirectory(dst);

    if (hasBackup) {
        await unlink(backupPath).catch((error) => {
            logger.warn(`Failed to remove atomic replace backup "${backupPath}": ${getErrorMessage(error)}`);
        });
    }
}
