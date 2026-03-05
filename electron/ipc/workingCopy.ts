import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import {
    constants as fsConstants,
    existsSync,
    mkdirSync,
    rmSync,
} from 'fs';
import {
    copyFile,
    readdir,
    rm,
    stat,
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
} from 'path';
import { createLogger } from '@electron/utils/logger';

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

    let latestMatch: string | null = null;
    for (const [
        workingPath,
        mappedOriginalPath,
    ] of workingCopyMap.entries()) {
        if (mappedOriginalPath === normalizedOriginalPath) {
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
    return Array.from(workingCopyMap.values())
        .some(mappedOriginalPath => mappedOriginalPath === normalizedOriginalPath);
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

        let workDirStat: Awaited<ReturnType<typeof stat>> | null = null;
        try {
            workDirStat = await stat(workDir);
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

        if (normalizedOriginalPath) {
            workingCopyMap.set(workingPath, normalizedOriginalPath);
        }

        return workingPath;
    } catch (error) {
        await safeRemoveDirectory(workDir);
        throw error;
    }
}

export async function handleFileSave(
    _event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<boolean> {
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = workingCopyMap.get(normalizedWorkingPath);

    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }
    if (!isAllowedOriginalSavePath(originalPath)) {
        throw new Error('Invalid original path for this working copy');
    }

    try {
        await copyFile(normalizedWorkingPath, originalPath);
        return true;
    } catch (err) {
        throw new Error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function cleanupWorkingCopyDirectory(workingPath: string) {
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
            if (existsSync(workDir)) {
                rmSync(workDir, {
                    recursive: true,
                    force: true,
                });
            }

            const ocrDir = `${workDir}.ocr`;
            if (existsSync(ocrDir)) {
                rmSync(ocrDir, {
                    recursive: true,
                    force: true,
                });
            }
        }
    } catch (err) {
        logger.warn(`Failed to delete working directory: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export function cleanupWorkingCopy(workingPath: string) {
    const normalizedPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    workingCopyMap.delete(normalizedPath);
    cleanupWorkingCopyDirectory(normalizedPath);
}

export function clearAllWorkingCopies() {
    for (const workingPath of workingCopyMap.keys()) {
        cleanupWorkingCopyDirectory(workingPath);
    }
    workingCopyMap.clear();
}
