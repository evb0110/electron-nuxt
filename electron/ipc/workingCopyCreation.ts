import { app } from 'electron';
import {
    existsSync,
    mkdirSync,
} from 'fs';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'path';
import { writeFile } from 'fs/promises';
import { decryptPdfFileIfNeeded } from '@electron/utils/pdfDecrypt';
import type { TOpenPath } from '@electron/ipc/openPathCapabilities';
import {
    copyFileCopyOnWrite,
    createWorkingDirectory,
    isWorkingCopyDirectoryName,
    safeRemoveDirectory,
} from '@electron/ipc/workingCopyDirectory';
import {
    forgetRetiredWorkingCopyOriginal,
    getWorkingCopyOriginalPath,
    setWorkingCopyOriginalPath,
} from '@electron/ipc/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/ipc/workingCopyValidation';
import { WorkingCopyMissingError } from '@electron/ipc/workingCopyMissingError';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('working-copy');

export async function createWorkingCopy(originalPath: TOpenPath): Promise<string> {
    const workDir = createWorkingDirectory();
    try {
        const fileName = basename(originalPath);
        const workingPath = join(workDir, fileName);
        await copyFileCopyOnWrite(originalPath, workingPath);
        if (workingPath.toLowerCase().endsWith('.pdf')) {
            await decryptPdfFileIfNeeded(workingPath);
        }

        setWorkingCopyOriginalPath(workingPath, originalPath);

        return workingPath;
    } catch (error) {
        await safeRemoveDirectory(workDir);
        throw error;
    }
}

export async function createWorkingCopyFromPath(
    sourcePath: TOpenPath,
    originalPath?: string,
): Promise<string> {
    const mappedOriginalPath = typeof originalPath === 'string' && originalPath.trim().length > 0
        ? originalPath.trim()
        : sourcePath;
    if (!isAllowedOriginalSavePath(mappedOriginalPath)) {
        throw new Error('Invalid original path mapping');
    }

    const workDir = createWorkingDirectory();
    try {
        const fileName = basename(sourcePath);
        const normalizedName = fileName.toLowerCase().endsWith('.pdf')
            ? fileName
            : `${fileName}.pdf`;
        const workingPath = join(workDir, normalizedName);

        await copyFileCopyOnWrite(sourcePath, workingPath);
        await decryptPdfFileIfNeeded(workingPath);

        setWorkingCopyOriginalPath(workingPath, mappedOriginalPath);

        return workingPath;
    } catch (error) {
        await safeRemoveDirectory(workDir);
        throw error;
    }
}

export async function createWorkingCopyFromData(
    fileName: string,
    data: Uint8Array,
    originalPath?: string,
): Promise<string> {
    const normalizedOriginalPath = typeof originalPath === 'string' && originalPath.trim().length > 0
        ? originalPath.trim()
        : null;
    if (normalizedOriginalPath && !isAllowedOriginalSavePath(normalizedOriginalPath)) {
        throw new Error('Invalid original path mapping');
    }

    const workDir = createWorkingDirectory();
    try {
        const baseName = basename(fileName);
        const normalizedName = baseName.toLowerCase().endsWith('.pdf')
            ? baseName
            : `${baseName}.pdf`;
        const workingPath = join(workDir, normalizedName);

        await writeFile(workingPath, data);
        await decryptPdfFileIfNeeded(workingPath);

        if (normalizedOriginalPath) {
            setWorkingCopyOriginalPath(workingPath, normalizedOriginalPath);
        }

        return workingPath;
    } catch (error) {
        await safeRemoveDirectory(workDir);
        throw error;
    }
}

export async function ensureWorkingCopyDirectory(workingPath: string) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    const mapping = getWorkingCopyOriginalPath(normalizedWorkingPath);
    if (!mapping) {
        return false;
    }
    const { originalPath } = mapping;

    const tempDir = resolve(app.getPath('temp'));
    const parentDir = resolve(dirname(normalizedWorkingPath));
    const relativePath = relative(tempDir, parentDir);
    const isWithinTemp = (
        relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
    );
    if (!isWithinTemp || !isWorkingCopyDirectoryName(basename(parentDir))) {
        throw new WorkingCopyMissingError('Working copy path is not a managed temp working directory');
    }

    if (existsSync(parentDir) && existsSync(normalizedWorkingPath)) {
        return true;
    }
    if (!existsSync(originalPath)) {
        throw new WorkingCopyMissingError('Working copy directory was removed and the original file is unavailable');
    }

    mkdirSync(parentDir, { recursive: true });
    await copyFileCopyOnWrite(originalPath, normalizedWorkingPath);
    if (normalizedWorkingPath.toLowerCase().endsWith('.pdf')) {
        await decryptPdfFileIfNeeded(normalizedWorkingPath);
    }
    if (mapping.retired) {
        setWorkingCopyOriginalPath(normalizedWorkingPath, originalPath);
        forgetRetiredWorkingCopyOriginal(normalizedWorkingPath);
    }
    logger.warn(`Recreated missing working copy directory for "${normalizedWorkingPath}"`);
    return true;
}

export async function requireManagedWorkingCopyPath(sourcePath: string): Promise<TOpenPath> {
    const normalizedSourcePath = typeof sourcePath === 'string' ? sourcePath.trim() : '';
    if (!normalizedSourcePath) {
        throw new Error('Invalid source path');
    }
    const isManagedWorkingCopy = await ensureWorkingCopyDirectory(normalizedSourcePath);
    if (!isManagedWorkingCopy) {
        throw new Error('Source path is not a managed working copy');
    }
    if (!existsSync(normalizedSourcePath)) {
        throw new Error(`File not found: ${normalizedSourcePath}`);
    }
    return normalizedSourcePath as TOpenPath;
}
