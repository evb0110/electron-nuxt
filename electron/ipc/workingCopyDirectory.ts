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
import { getAppTempDir } from '@electron/utils/appTempDir';

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
        await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE_FORCE);
        return;
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        const shouldFallback = err.code === 'ENOTSUP'
            || err.code === 'ENOSYS'
            || err.code === 'EINVAL'
            || err.code === 'EXDEV';
        if (!shouldFallback) {
            throw error;
        }
    }

    await copyFile(sourcePath, targetPath);
}
