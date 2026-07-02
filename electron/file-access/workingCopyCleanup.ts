import { statSync } from 'fs';
import {
    readdir,
    rm,
} from 'fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    clearRetiredWorkingCopyOriginals,
    clearWorkingCopyOriginalPaths,
    forgetWorkingCopyOriginalPath,
    getWorkingCopyOwnerWebContentsId,
    rememberRetiredWorkingCopyOriginal,
    workingCopyMap,
} from '@electron/file-access/workingCopyStore';
import {
    isWorkingCopyDirectoryName,
    safeRemoveDirectory,
} from '@electron/file-access/workingCopyDirectory';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { drainWorkingCopyMutations } from '@electron/file-access/workingCopyMutationQueue';

const logger = createLogger('working-copy');
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

export async function cleanupStaleWorkingCopyDirectories() {
    const tempDir = resolve(getAppTempDir());
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

async function cleanupWorkingCopyDirectory(workingPath: string) {
    const normalizedPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    try {
        const tempDir = resolve(getAppTempDir());
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

export function cleanupWorkingCopy(workingPath: string, senderWebContentsId?: number) {
    const normalizedPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    const originalEntry = workingCopyMap.get(normalizedPath);
    if (!originalEntry) {
        logger.warn(`Rejected cleanup for unmanaged working copy path "${normalizedPath}"`);
        return;
    }
    const ownerWebContentsId = getWorkingCopyOwnerWebContentsId(normalizedPath);
    if (
        typeof ownerWebContentsId === 'number'
        && ownerWebContentsId !== senderWebContentsId
    ) {
        logger.warn(`Rejected cleanup for working copy path owned by another sender "${normalizedPath}"`);
        return;
    }

    rememberRetiredWorkingCopyOriginal(
        normalizedPath,
        originalEntry.originalPath,
        ownerWebContentsId,
        {
            ...(originalEntry.originalFileExpectation ? {originalFileExpectation: originalEntry.originalFileExpectation} : {}),
            role: originalEntry.role,
        },
    );
    forgetWorkingCopyOriginalPath(normalizedPath);
    cleanupWorkingCopyDirectory(normalizedPath).catch((err) => {
        logger.warn(`Failed to cleanup working copy directory "${normalizedPath}": ${getErrorMessage(err)}`);
    });
}

export async function clearAllWorkingCopies() {
    await drainWorkingCopyMutations();
    const paths = [...workingCopyMap.keys()];
    clearWorkingCopyOriginalPaths();
    clearRetiredWorkingCopyOriginals();
    await Promise.allSettled(
        paths.map(workingPath => cleanupWorkingCopyDirectory(workingPath)),
    );
}
