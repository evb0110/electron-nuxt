import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import {
    constants as fsConstants,
    existsSync,
    mkdirSync,
    statSync,
} from 'fs';
import {
    copyFile,
    readdir,
    rm,
    writeFile,
} from 'fs/promises';
import {
    join,
    basename,
    dirname,
    resolve,
    relative,
    sep,
    isAbsolute,
    extname,
    win32,
} from 'path';
import { createLogger } from '@electron/utils/logger';
import { decryptPdfFileIfNeeded } from '@electron/utils/pdf-decrypt';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('working-copy');
const ALLOWED_SAVE_EXTENSIONS = new Set([
    '.pdf',
    '.djvu',
    '.djv',
]);
const STALE_WORK_DIR_MAX_AGE_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_WORKING_COPY_STALE_MAX_AGE_MS ?? `${24 * 60 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 60_000) {
        return 24 * 60 * 60 * 1000;
    }
    return parsed;
})();
const STALE_WORK_DIR_SCAN_LIMIT = (() => {
    const parsed = Number.parseInt(process.env.EVB_WORKING_COPY_STALE_SCAN_LIMIT ?? '512', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 512;
    }
    return Math.min(parsed, 10_000);
})();

export const workingCopyMap = new Map<string, string>();
const retiredWorkingCopyOriginalMap = new Map<string, {
    expiresAtMs: number;
    originalPath: string;
}>();
const RETIRED_WORKING_COPY_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RETIRED_WORKING_COPY_TTL_MS ?? `${10 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        return 10 * 60 * 1000;
    }
    return Math.min(parsed, 60 * 60 * 1000);
})();

function stripWindowsExtendedLengthPrefix(filePath: string) {
    if (filePath.startsWith('\\\\?\\UNC\\')) {
        return `\\\\${filePath.slice(8)}`;
    }
    if (filePath.startsWith('\\\\?\\')) {
        return filePath.slice(4);
    }
    return filePath;
}

function isWindowsPathLike(filePath: string) {
    const normalizedPath = stripWindowsExtendedLengthPrefix(filePath);
    return /^[a-zA-Z]:[\\/]/.test(normalizedPath) || normalizedPath.startsWith('\\\\');
}

function normalizePathForLookup(filePath: string) {
    const trimmedPath = filePath.trim();
    if (!trimmedPath) {
        return '';
    }

    if (isWindowsPathLike(trimmedPath)) {
        return win32.resolve(stripWindowsExtendedLengthPrefix(trimmedPath)).toLowerCase();
    }

    return resolve(trimmedPath);
}

export class WorkingCopyMissingError extends Error {
    code = 'WORKING_COPY_MISSING';

    constructor(message = 'Working copy is no longer available') {
        super(message);
        this.name = 'WorkingCopyMissingError';
    }
}

function pruneRetiredWorkingCopyOriginals() {
    const now = Date.now();
    for (const [
        workingPath,
        entry,
    ] of retiredWorkingCopyOriginalMap.entries()) {
        if (entry.expiresAtMs <= now) {
            retiredWorkingCopyOriginalMap.delete(workingPath);
        }
    }
}

export function getWorkingCopyOriginalPath(workingPath: string) {
    const activeOriginalPath = workingCopyMap.get(workingPath);
    if (activeOriginalPath) {
        return {
            originalPath: activeOriginalPath,
            retired: false,
        };
    }

    pruneRetiredWorkingCopyOriginals();
    const retired = retiredWorkingCopyOriginalMap.get(workingPath);
    if (!retired) {
        return null;
    }

    return {
        originalPath: retired.originalPath,
        retired: true,
    };
}

function rememberRetiredWorkingCopyOriginal(workingPath: string, originalPath: string | undefined) {
    if (!originalPath) {
        return;
    }
    retiredWorkingCopyOriginalMap.set(workingPath, {
        originalPath,
        expiresAtMs: Date.now() + RETIRED_WORKING_COPY_TTL_MS,
    });
}

function isAllowedOriginalSavePath(path: string) {
    if (!isAbsolute(path)) {
        return false;
    }
    return ALLOWED_SAVE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function findWorkingCopyPathByOriginalPath(originalPath: string): string | null {
    const normalizedOriginalPath = typeof originalPath === 'string' ? originalPath.trim() : '';
    if (!normalizedOriginalPath) {
        return null;
    }

    const lookupOriginalPath = normalizePathForLookup(normalizedOriginalPath);
    let latestMatch: string | null = null;
    for (const [
        workingPath,
        mappedOriginalPath,
    ] of workingCopyMap.entries()) {
        if (normalizePathForLookup(mappedOriginalPath) === lookupOriginalPath) {
            latestMatch = workingPath;
        }
    }

    return latestMatch;
}

export function isKnownWorkingCopyOriginalPath(originalPath: string) {
    const normalizedOriginalPath = typeof originalPath === 'string' ? originalPath.trim() : '';
    if (!normalizedOriginalPath) {
        return false;
    }
    const lookupOriginalPath = normalizePathForLookup(normalizedOriginalPath);
    return Array.from(workingCopyMap.values())
        .some(mappedOriginalPath => normalizePathForLookup(mappedOriginalPath) === lookupOriginalPath);
}

function createWorkingDirectory() {
    const tempDir = app.getPath('temp');
    const workDir = join(tempDir, `pdf-work-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    return workDir;
}

function isWorkingCopyDirectoryName(name: string) {
    return name.startsWith('pdf-work-');
}

async function safeRemoveDirectory(path: string) {
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

export async function cleanupStaleWorkingCopyDirectories() {
    const tempDir = resolve(app.getPath('temp'));
    let entries: string[] = [];
    try {
        entries = await readdir(tempDir);
    } catch {
        return {
            removedDirectories: 0,
            removedOcrDirectories: 0,
        };
    }

    let removedDirectories = 0;
    let removedOcrDirectories = 0;
    let scannedCount = 0;
    const now = Date.now();

    for (const entryName of entries) {
        if (scannedCount >= STALE_WORK_DIR_SCAN_LIMIT) {
            break;
        }
        if (!isWorkingCopyDirectoryName(entryName) || entryName.endsWith('.ocr')) {
            continue;
        }
        scannedCount += 1;

        const workDir = resolve(join(tempDir, entryName));
        const relativePath = relative(tempDir, workDir);
        const isWithinTemp = (
            relativePath !== '..'
            && !relativePath.startsWith(`..${sep}`)
            && !isAbsolute(relativePath)
        );
        if (!isWithinTemp) {
            continue;
        }

        let workDirStat: ReturnType<typeof statSync> | null = null;
        try {
            workDirStat = statSync(workDir);
        } catch {
            continue;
        }
        if (!workDirStat.isDirectory()) {
            continue;
        }
        if (now - workDirStat.mtimeMs < STALE_WORK_DIR_MAX_AGE_MS) {
            continue;
        }

        if (await safeRemoveDirectory(workDir)) {
            removedDirectories += 1;
        }

        const ocrDir = `${workDir}.ocr`;
        if (await safeRemoveDirectory(ocrDir)) {
            removedOcrDirectories += 1;
        }
    }

    if (removedDirectories > 0 || removedOcrDirectories > 0) {
        logger.info(
            `Cleaned stale working copy temp directories (work=${removedDirectories}, ocr=${removedOcrDirectories}, scanned=${scannedCount})`,
        );
    }

    return {
        removedDirectories,
        removedOcrDirectories,
    };
}

async function copyFileCopyOnWrite(sourcePath: string, targetPath: string) {
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

export async function createWorkingCopy(originalPath: string): Promise<string> {
    const workDir = createWorkingDirectory();
    try {
        const fileName = basename(originalPath);
        const workingPath = join(workDir, fileName);
        await copyFileCopyOnWrite(originalPath, workingPath);
        if (workingPath.toLowerCase().endsWith('.pdf')) {
            await decryptPdfFileIfNeeded(workingPath);
        }

        workingCopyMap.set(workingPath, originalPath);

        return workingPath;
    } catch (error) {
        await safeRemoveDirectory(workDir);
        throw error;
    }
}

export async function createWorkingCopyFromPath(
    sourcePath: string,
    originalPath?: string,
): Promise<string> {
    const normalizedSourcePath = typeof sourcePath === 'string' ? sourcePath.trim() : '';
    if (!normalizedSourcePath) {
        throw new Error('Invalid source path');
    }

    const mappedOriginalPath = typeof originalPath === 'string' && originalPath.trim().length > 0
        ? originalPath.trim()
        : normalizedSourcePath;
    if (!isAllowedOriginalSavePath(mappedOriginalPath)) {
        throw new Error('Invalid original path mapping');
    }

    const workDir = createWorkingDirectory();
    try {
        const fileName = basename(normalizedSourcePath);
        const normalizedName = fileName.toLowerCase().endsWith('.pdf')
            ? fileName
            : `${fileName}.pdf`;
        const workingPath = join(workDir, normalizedName);

        await copyFileCopyOnWrite(normalizedSourcePath, workingPath);
        await decryptPdfFileIfNeeded(workingPath);

        workingCopyMap.set(workingPath, mappedOriginalPath);

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
            workingCopyMap.set(workingPath, normalizedOriginalPath);
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
        workingCopyMap.set(normalizedWorkingPath, originalPath);
        retiredWorkingCopyOriginalMap.delete(normalizedWorkingPath);
    }
    logger.warn(`Recreated missing working copy directory for "${normalizedWorkingPath}"`);
    return true;
}

export async function handleFileSave(
    _event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<boolean> {
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = getWorkingCopyOriginalPath(normalizedWorkingPath)?.originalPath;

    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }
    if (!isAllowedOriginalSavePath(originalPath)) {
        throw new Error('Invalid original path for this working copy');
    }

    try {
        await ensureWorkingCopyDirectory(normalizedWorkingPath);
        await copyFile(normalizedWorkingPath, originalPath);
        return true;
    } catch (err) {
        if (err instanceof WorkingCopyMissingError) {
            throw err;
        }
        throw new Error(`Failed to save: ${getErrorMessage(err)}`);
    }
}

async function cleanupWorkingCopyDirectory(workingPath: string) {
    const normalizedPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    try {
        const tempDir = resolve(app.getPath('temp'));
        const workDir = resolve(dirname(normalizedPath));
        const relativePath = relative(tempDir, workDir);
        const workDirName = basename(workDir);

        const isWithinTemp = (
            relativePath !== '..'
            && !relativePath.startsWith(`..${sep}`)
            && !isAbsolute(relativePath)
        );
        const isWorkingCopyDir = workDirName.startsWith('pdf-work-');

        if (isWithinTemp && isWorkingCopyDir) {
            const ocrDir = `${workDir}.ocr`;
            await Promise.all([
                rm(workDir, {
                    recursive: true,
                    force: true,
                }),
                rm(ocrDir, {
                    recursive: true,
                    force: true,
                }),
            ]);
        }
    } catch (err) {
        logger.warn(`Failed to delete working directory: ${getErrorMessage(err)}`);
    }
}

export function cleanupWorkingCopy(workingPath: string) {
    const normalizedPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    rememberRetiredWorkingCopyOriginal(normalizedPath, workingCopyMap.get(normalizedPath));
    workingCopyMap.delete(normalizedPath);
    cleanupWorkingCopyDirectory(normalizedPath).catch((err) => {
        logger.warn(`Failed to cleanup working copy directory "${normalizedPath}": ${getErrorMessage(err)}`);
    });
}

export async function clearAllWorkingCopies() {
    const paths = [...workingCopyMap.keys()];
    workingCopyMap.clear();
    retiredWorkingCopyOriginalMap.clear();
    await Promise.allSettled(
        paths.map(workingPath => cleanupWorkingCopyDirectory(workingPath)),
    );
}
