import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { getErrorMessage } from '@electron/utils/error';
import { atomicReplace } from '@electron/utils/atomicReplace';

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
    void options;
    await atomicReplace(tempPath, targetPath);
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
