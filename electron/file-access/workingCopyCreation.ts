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
import { decryptPdfFileIfNeeded } from '@electron/utils/decryptPdfFileIfNeeded';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import {
    copyFileCopyOnWrite,
    createWorkingDirectory,
    isWorkingCopyDirectoryName,
    safeRemoveDirectory,
} from '@electron/file-access/workingCopyDirectory';
import {
    forgetRetiredWorkingCopyOriginal,
    getWorkingCopyOriginalPath,
    getWorkingCopyRole,
    isKnownWorkingCopyOriginalPath,
    setWorkingCopyOriginalPath,
    type TWorkingCopyRole,
} from '@electron/file-access/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';
import { WorkingCopyMissingError } from '@electron/file-access/workingCopyMissingError';
import { createLogger } from '@electron/utils/createLogger';
import { getAppTempDir } from '@electron/utils/appTempDir';
import {
    ensureWorkingCopyRevision,
    markWorkingCopyContentChanged,
} from '@electron/file-access/documentRevisionStore';
import { readWorkingCopySyncRequiredJournalEntry } from '@electron/file-access/documentRevisionSidecar';
import {initializePageIdentityStore} from '@electron/file-access/pageIdentityStore';

const logger = createLogger('working-copy');

function resolveWorkingCopyRoleForPathClone(
    sourcePath: string,
    ownerWebContentsId?: number,
): TWorkingCopyRole {
    return getWorkingCopyOriginalPath(sourcePath, ownerWebContentsId) ? 'snapshot' : 'current';
}

export async function createWorkingCopy(originalPath: TOpenPath, ownerWebContentsId?: number) {
    const workDir = createWorkingDirectory();
    try {
        const fileName = basename(originalPath);
        const workingPath = join(workDir, fileName);
        await copyFileCopyOnWrite(originalPath, workingPath);
        if (workingPath.toLowerCase().endsWith('.pdf')) {
            await decryptPdfFileIfNeeded(workingPath);
        }

        await setWorkingCopyOriginalPath(workingPath, originalPath, ownerWebContentsId);
        const revision = await ensureWorkingCopyRevision(workingPath, ownerWebContentsId);
        if (workingPath.toLowerCase().endsWith('.pdf')) {
            await initializePageIdentityStore(workingPath, revision, originalPath);
        }

        return workingPath;
    } catch (error) {
        await safeRemoveDirectory(workDir);
        throw error;
    }
}

export async function createWorkingCopyFromPath(
    sourcePath: TOpenPath,
    originalPath?: string,
    ownerWebContentsId?: number,
) {
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

        const role = resolveWorkingCopyRoleForPathClone(sourcePath, ownerWebContentsId);
        await setWorkingCopyOriginalPath(workingPath, mappedOriginalPath, ownerWebContentsId, {role});
        const revision = await ensureWorkingCopyRevision(workingPath, ownerWebContentsId);
        await initializePageIdentityStore(workingPath, revision, sourcePath);

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
    ownerWebContentsId?: number,
) {
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
            const role = isKnownWorkingCopyOriginalPath(normalizedOriginalPath, ownerWebContentsId) ? 'snapshot' : 'current';
            await setWorkingCopyOriginalPath(workingPath, normalizedOriginalPath, ownerWebContentsId, {role});
        }
        const revision = await ensureWorkingCopyRevision(workingPath, ownerWebContentsId);
        await initializePageIdentityStore(workingPath, revision);

        return workingPath;
    } catch (error) {
        await safeRemoveDirectory(workDir);
        throw error;
    }
}

export async function ensureWorkingCopyDirectory(workingPath: string, senderWebContentsId?: number) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    let mapping = getWorkingCopyOriginalPath(normalizedWorkingPath, senderWebContentsId);
    if (!mapping) {
        const pendingSync = readWorkingCopySyncRequiredJournalEntry(normalizedWorkingPath);
        if (
            pendingSync?.originalPath
            && (
                pendingSync.ownerWebContentsId === undefined
                || pendingSync.ownerWebContentsId === senderWebContentsId
            )
        ) {
            await setWorkingCopyOriginalPath(
                normalizedWorkingPath,
                pendingSync.originalPath,
                pendingSync.ownerWebContentsId,
            );
            mapping = getWorkingCopyOriginalPath(normalizedWorkingPath, senderWebContentsId);
        }
    }
    if (!mapping) {
        return false;
    }
    const { originalPath } = mapping;

    const tempDir = resolve(getAppTempDir());
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
        const role = getWorkingCopyRole(normalizedWorkingPath, senderWebContentsId) ?? 'current';
        await setWorkingCopyOriginalPath(normalizedWorkingPath, originalPath, mapping.ownerWebContentsId, {role});
        forgetRetiredWorkingCopyOriginal(normalizedWorkingPath);
    }
    await markWorkingCopyContentChanged(normalizedWorkingPath, 'replace-working-copy', senderWebContentsId);
    logger.warn(`Recreated missing working copy directory for "${normalizedWorkingPath}"`);
    return true;
}

export async function requireManagedWorkingCopyPath(sourcePath: string, senderWebContentsId?: number): Promise<TOpenPath> {
    const normalizedSourcePath = typeof sourcePath === 'string' ? sourcePath.trim() : '';
    if (!normalizedSourcePath) {
        throw new Error('Invalid source path');
    }
    const isManagedWorkingCopy = await ensureWorkingCopyDirectory(normalizedSourcePath, senderWebContentsId);
    if (!isManagedWorkingCopy) {
        throw new Error('Source path is not a managed working copy');
    }
    if (!existsSync(normalizedSourcePath)) {
        throw new Error(`File not found: ${normalizedSourcePath}`);
    }
    return normalizedSourcePath as TOpenPath;
}
