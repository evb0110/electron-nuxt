import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import {
    unlink,
    rename,
} from 'fs/promises';
import { join } from 'path';
import { getErrorMessage } from '@electron/utils/error';

interface ITempOutputLogger { debug(msg: string): void; }

export function makeTempPdfOutputPath(targetPath: string) {
    const dir = join(targetPath, '..');
    const id = `tmp-${randomUUID()}`;
    return join(dir, `${id}.pdf`);
}

export async function replaceTempOutput(
    tempPath: string,
    targetPath: string,
    options: { replaceExistingTargetOnFailure?: boolean } = {},
) {
    try {
        await rename(tempPath, targetPath);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (
            !options.replaceExistingTargetOnFailure
            || (err.code !== 'EEXIST' && err.code !== 'EPERM')
        ) {
            throw error;
        }

        await unlink(targetPath);
        await rename(tempPath, targetPath);
    }
}

export async function cleanupTempOutput(
    tempPath: string,
    log: ITempOutputLogger,
    failureLabel: string,
) {
    try {
        if (existsSync(tempPath)) {
            await unlink(tempPath);
        }
    } catch (cleanupError) {
        log.debug(`Failed to cleanup ${failureLabel} "${tempPath}": ${
            getErrorMessage(cleanupError)
        }`);
    }
}
