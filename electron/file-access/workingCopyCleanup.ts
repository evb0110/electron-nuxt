import {
    readdir,
    rm,
    stat,
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
    forgetRetiredWorkingCopyOriginal,
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
import {
    clearWorkingCopyRevisionInitializations,
    forgetWorkingCopyRevisionInitialization,
    hasWorkingCopySyncRequired,
} from '@electron/file-access/documentRevisionStore';
import {
    clearPageIdentityStoreInitializations,
    forgetPageIdentityStoreInitialization,
} from '@electron/file-access/pageIdentityStore';

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

export interface ICleanupStaleWorkingCopyDirectoriesOptions {statConcurrency?: number;}

export async function cleanupStaleWorkingCopyDirectories(
    options: ICleanupStaleWorkingCopyDirectoriesOptions = {},
): Promise<{
    removedDirectories: number;
    removedOcrDirectories: number;
}> {
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
    const now = Date.now();
    const candidates = entries
        .filter(entryName => isWorkingCopyDirectoryName(entryName) && !entryName.endsWith('.ocr'))
        .slice(0, STALE_WORK_DIR_SCAN_LIMIT)
        .map(entryName => resolve(join(tempDir, entryName)))
        .filter((workDir) => {
            const relativePath = relative(tempDir, workDir);
            return relativePath !== '..'
                && !relativePath.startsWith(`..${sep}`)
                && !isAbsolute(relativePath);
        });
    const workerCount = Math.min(
        candidates.length,
        Math.max(1, Math.trunc(options.statConcurrency ?? 8)),
    );
    let nextCandidateIndex = 0;

    await Promise.all(Array.from({length: workerCount}, async () => {
        while (nextCandidateIndex < candidates.length) {
            const candidateIndex = nextCandidateIndex;
            nextCandidateIndex += 1;
            const workDir = candidates[candidateIndex];
            if (!workDir) {
                continue;
            }

            try {
                const workDirStat = await stat(workDir);
                if (!workDirStat.isDirectory() || now - workDirStat.mtimeMs < STALE_WORK_DIR_MAX_AGE_MS) {
                    continue;
                }
            } catch {
                continue;
            }

            if (await safeRemoveDirectory(workDir)) {
                removedDirectories += 1;
            }
            if (await safeRemoveDirectory(`${workDir}.ocr`)) {
                removedOcrDirectories += 1;
            }
        }
    }));

    if (removedDirectories > 0 || removedOcrDirectories > 0) {
        logger.info(
            `Cleaned stale working copy temp directories (work=${removedDirectories}, ocr=${removedOcrDirectories}, scanned=${candidates.length})`,
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

export async function cleanupWorkingCopy(workingPath: string, senderWebContentsId?: number) {
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

    await drainWorkingCopyMutations(normalizedPath);
    const currentEntry = workingCopyMap.get(normalizedPath);
    if (!currentEntry) {
        return;
    }
    const currentOwnerWebContentsId = getWorkingCopyOwnerWebContentsId(normalizedPath);
    if (
        typeof currentOwnerWebContentsId === 'number'
        && currentOwnerWebContentsId !== senderWebContentsId
    ) {
        logger.warn(`Rejected cleanup for working copy path whose owner changed while waiting "${normalizedPath}"`);
        return;
    }

    rememberRetiredWorkingCopyOriginal(
        normalizedPath,
        currentEntry.originalPath,
        currentOwnerWebContentsId,
        {
            ...(currentEntry.originalFileExpectation ? {originalFileExpectation: currentEntry.originalFileExpectation} : {}),
            role: currentEntry.role,
        },
    );
    forgetWorkingCopyOriginalPath(normalizedPath);
    forgetWorkingCopyRevisionInitialization(normalizedPath);
    forgetPageIdentityStoreInitialization(normalizedPath);
    await cleanupWorkingCopyDirectory(normalizedPath);
}

export async function clearAllWorkingCopies(options: {skipPaths?: Iterable<string>} = {}) {
    await drainWorkingCopyMutations();
    const paths = [...workingCopyMap.keys()];
    const skipPaths = new Set(Array.from(options.skipPaths ?? [])
        .map(path => typeof path === 'string' ? path.trim() : '')
        .filter(Boolean));
    for (const workingPath of paths) {
        if (hasWorkingCopySyncRequired(workingPath)) {
            skipPaths.add(workingPath);
        }
    }
    const pathsToDelete = skipPaths.size === 0
        ? paths
        : paths.filter(path => !skipPaths.has(path));

    if (skipPaths.size === 0) {
        clearWorkingCopyOriginalPaths();
        clearRetiredWorkingCopyOriginals();
        clearWorkingCopyRevisionInitializations();
        clearPageIdentityStoreInitializations();
    } else {
        for (const workingPath of pathsToDelete) {
            forgetWorkingCopyOriginalPath(workingPath);
            forgetRetiredWorkingCopyOriginal(workingPath);
            forgetWorkingCopyRevisionInitialization(workingPath);
            forgetPageIdentityStoreInitialization(workingPath);
        }
        logger.error(
            `Skipped shutdown deletion for ${skipPaths.size} working copy path(s) with pending writes or dirty sync state: ${
                Array.from(skipPaths).join(', ')
            }`,
        );
    }

    await Promise.allSettled(
        pathsToDelete.map(workingPath => cleanupWorkingCopyDirectory(workingPath)),
    );
}
