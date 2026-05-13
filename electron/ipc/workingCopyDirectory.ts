import { app } from 'electron';
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
import {
    join,
    relative,
    resolve,
    sep,
    isAbsolute,
} from 'path';

export function createWorkingDirectory() {
    const tempDir = app.getPath('temp');
    const workDir = join(tempDir, `pdf-work-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    return workDir;
}

export function isWorkingCopyDirectoryName(name: string) {
    return name.startsWith('pdf-work-');
}

export function isManagedWorkingCopyDirectory(workDir: string) {
    const tempDir = resolve(app.getPath('temp'));
    const resolvedWorkDir = resolve(workDir);
    const relativePath = relative(tempDir, resolvedWorkDir);
    return (
        relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
        && isWorkingCopyDirectoryName(resolvedWorkDir.split(/[\\/]/u).pop() ?? '')
    );
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
