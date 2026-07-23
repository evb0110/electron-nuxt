import { randomUUID } from 'node:crypto';
import {
    constants as fsConstants,
    existsSync,
    mkdirSync,
} from 'fs';
import {
    copyFile,
    rm,
} from 'fs/promises';
import {join} from 'path';
import { isErrnoException } from '@contracts/runtimeGuards';
import { getAppTempDir } from '@electron/utils/appTempDir';

const COPY_ON_WRITE_FALLBACK_CODES = new Set([
    'ENOTSUP',
    'ENOSYS',
    'EINVAL',
    'EXDEV',
]);

function isCopyOnWriteUnavailable(error: unknown) {
    return isErrnoException(error)
        && typeof error.code === 'string'
        && COPY_ON_WRITE_FALLBACK_CODES.has(error.code);
}

export function createWorkingDirectory() {
    const tempDir = getAppTempDir();
    const workDir = join(tempDir, `pdf-work-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    return workDir;
}

export function isWorkingCopyDirectoryName(name: string) {
    return name.startsWith('pdf-work-');
}

export async function safeRemoveDirectory(path: string) {
    if (!existsSync(path)) {
        return false;
    }

    try {
        await rm(path, {
            recursive: true,
            force: true,
        });
        return true;
    } catch {
        return false;
    }
}

export async function copyFileCopyOnWrite(sourcePath: string, targetPath: string) {
    try {
        await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE);
        return;
    } catch (error) {
        if (!isCopyOnWriteUnavailable(error)) {
            throw error;
        }
    }

    await copyFile(sourcePath, targetPath);
}
