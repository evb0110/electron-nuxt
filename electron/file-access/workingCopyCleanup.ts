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
    forgetRetiredWorkingCopyOriginal,
    forgetWorkingCopyOriginalPath,
    getWorkingCopyOwnerWebContentsId,
    rememberRetiredWorkingCopyOriginal,
    runWithWorkingCopyRegistrationFence,
    workingCopyMap,
    type IWorkingCopyOriginalEntry,
} from '@electron/file-access/workingCopyStore';
import {
    isWorkingCopyDirectoryName,
    safeRemoveDirectory,
} from '@electron/file-access/workingCopyDirectory';
import {
    getAppTempDir,
    getLegacyAppTempDirPath,
} from '@electron/utils/appTempDir';
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
import {
    cancelWorkingCopyMaterialization,
    ensureWorkingCopyMaterialized,
} from '@electron/file-access/workingCopyMaterialization';
import {
    cancelAbortableMainOperationsForWorkingCopy,
    snapshotMainOperations,
} from '@electron/operation-lifecycle/mainOperationLifecycle';

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
    let removedDirectories = 0;
    let removedOcrDirectories = 0;
    const now = Date.now();
    const tempDirs = Array.from(new Set([
        resolve(getAppTempDir()),
        resolve(getLegacyAppTempDirPath()),
    ]));
    const entriesByTempDir = await Promise.all(tempDirs.map(async (tempDir) => {
        try {
            return (await readdir(tempDir)).map(entryName => ({
                entryName,
                tempDir,
            }));
        } catch {
            return [];
        }
    }));
    const candidates = entriesByTempDir.flat()
        .filter(({entryName}) => isWorkingCopyDirectoryName(entryName) && !entryName.endsWith('.ocr'))
        .slice(0, STALE_WORK_DIR_SCAN_LIMIT)
        .map(({
            entryName,
            tempDir,
        }) => ({
            tempDir,
            workDir: resolve(join(tempDir, entryName)),
        }))
        .filter(({
            tempDir,
            workDir,
        }) => {
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
            const candidate = candidates[candidateIndex];
            if (!candidate) {
                continue;
            }
            const {workDir} = candidate;

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

function isPathWithin(parentPath: string, candidatePath: string) {
    const relativePath = relative(parentPath, candidatePath);
    return relativePath === '' || (
        relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
    );
}

async function cleanupWorkingCopyDirectory(
    workingPath: string,
    originalPath?: string,
) {
    const normalizedPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    try {
        const tempDirs = new Set([
            resolve(getAppTempDir()),
            resolve(getLegacyAppTempDirPath()),
        ]);
        const workDir = resolve(dirname(normalizedPath));
        const workDirName = basename(workDir);
        const isWithinTemp = Array.from(tempDirs).some((tempDir) => {
            const relativePath = relative(tempDir, workDir);
            return relativePath !== '..'
                && !relativePath.startsWith(`..${sep}`)
                && !isAbsolute(relativePath);
        });
        const isWorkingCopyDir = workDirName.startsWith('pdf-work-');

        if (isWithinTemp && isWorkingCopyDir) {
            const ocrDir = `${workDir}.ocr`;
            const resolvedOriginalPath = originalPath ? resolve(originalPath) : null;
            if (resolvedOriginalPath && isPathWithin(workDir, resolvedOriginalPath)) {
                logger.error(`Refused to delete a working directory containing its original backing: ${workDir}`);
                await rm(ocrDir, {
                    recursive: true,
                    force: true,
                });
                return;
            }
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

function getMaterializationOperations(workingPath: string) {
    return snapshotMainOperations()
        .filter(operation => operation.workingCopyPath === workingPath);
}

async function waitForOperationSettlement(operationIds: Set<string>) {
    while (
        operationIds.size > 0
        && snapshotMainOperations().some(operation => operationIds.has(operation.id))
    ) {
        await new Promise<void>((resolveSettlement) => {
            setImmediate(resolveSettlement);
        });
    }
}

async function settleWorkingCopyMaterialization(
    workingPath: string,
    entry: IWorkingCopyOriginalEntry,
) {
    if (entry.backingState !== 'materializing') {
        return;
    }
    const joined = await runWithWorkingCopyRegistrationFence(
        workingPath,
        entry.registrationId,
        (currentEntry) => {
            if (currentEntry.backingState !== 'materializing') {
                return null;
            }
            const initialOperations = getMaterializationOperations(workingPath);
            const hasActiveDemand = initialOperations.some(operation => (
                operation.kind === 'critical-write'
                && !operation.aborted
            ));
            const settlement = ensureWorkingCopyMaterialized(workingPath, {
                ...(currentEntry.ownerWebContentsId === undefined
                    ? {}
                    : {ownerWebContentsId: currentEntry.ownerWebContentsId}),
                reason: 'checkpoint-recovery',
            });
            return {
                hasActiveDemand,
                operations: hasActiveDemand
                    ? initialOperations
                    : getMaterializationOperations(workingPath),
                settlement,
            };
        },
    );
    if (!joined.matched || !joined.value) {
        return;
    }

    const {
        hasActiveDemand,
        operations,
        settlement,
    } = joined.value;
    const abortableOperationIds = new Set(
        operations
            .filter(operation => operation.kind === 'abortable-work')
            .map(operation => operation.id),
    );
    if (!hasActiveDemand) {
        for (const operation of [...operations].reverse()) {
            if (operation.kind === 'abortable-work') {
                const cancelled = cancelWorkingCopyMaterialization(
                    operation.id,
                    'Working-copy materialization cancelled during cleanup',
                );
                if (cancelled) {
                    break;
                }
            }
        }
    }
    await settlement.catch((error) => {
        logger.debug(
            `${hasActiveDemand ? 'Joined' : 'Cancelled'} working-copy materialization settled with an error: ${
                getErrorMessage(error)
            }`,
        );
    });
    await waitForOperationSettlement(abortableOperationIds);
}

async function retireWorkingCopyRegistration(
    workingPath: string,
    entry: IWorkingCopyOriginalEntry,
) {
    const retirement = await runWithWorkingCopyRegistrationFence(
        workingPath,
        entry.registrationId,
        (currentEntry) => {
            rememberRetiredWorkingCopyOriginal(
                workingPath,
                currentEntry.originalPath,
                currentEntry.ownerWebContentsId,
                {
                    ...(currentEntry.admissionSnapshot ? {admissionSnapshot: currentEntry.admissionSnapshot} : {}),
                    backingState: currentEntry.backingState,
                    ...(currentEntry.originalFileExpectation
                        ? {originalFileExpectation: currentEntry.originalFileExpectation}
                        : {}),
                    role: currentEntry.role,
                    ...(currentEntry.sourceBackingErrorCode
                        ? {sourceBackingErrorCode: currentEntry.sourceBackingErrorCode}
                        : {}),
                },
            );
            forgetWorkingCopyOriginalPath(workingPath);
            return currentEntry.originalPath;
        },
    );
    return retirement.matched ? retirement.value : null;
}

export async function settleAllWorkingCopyMaterializations() {
    const materializingEntries = [...workingCopyMap.entries()]
        .filter(([
            , entry,
        ]) => entry.backingState === 'materializing');
    await Promise.allSettled(materializingEntries.map(([
        workingPath,
        entry,
    ]) => (
        settleWorkingCopyMaterialization(workingPath, entry)
    )));
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

    const canceledOperations = cancelAbortableMainOperationsForWorkingCopy(
        normalizedPath,
        'Working copy is closing',
    );
    if (canceledOperations > 0) {
        logger.debug(`Cancelled ${canceledOperations} abortable operation(s) for a closing working copy`);
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

    await settleWorkingCopyMaterialization(normalizedPath, currentEntry);
    const originalPath = await retireWorkingCopyRegistration(normalizedPath, currentEntry);
    if (!originalPath) {
        logger.warn(`Skipped cleanup for a working copy whose registration changed while settling "${normalizedPath}"`);
        return;
    }
    forgetWorkingCopyRevisionInitialization(normalizedPath);
    forgetPageIdentityStoreInitialization(normalizedPath);
    await cleanupWorkingCopyDirectory(normalizedPath, originalPath);
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

    const retiredPaths = new Map<string, string>();
    await Promise.all(pathsToDelete.map(async (workingPath) => {
        const entry = workingCopyMap.get(workingPath);
        if (!entry) {
            return;
        }
        await settleWorkingCopyMaterialization(workingPath, entry);
        const originalPath = await retireWorkingCopyRegistration(workingPath, entry);
        if (!originalPath) {
            skipPaths.add(workingPath);
            return;
        }
        retiredPaths.set(workingPath, originalPath);
        forgetRetiredWorkingCopyOriginal(workingPath);
        forgetWorkingCopyRevisionInitialization(workingPath);
        forgetPageIdentityStoreInitialization(workingPath);
    }));

    if (workingCopyMap.size === 0) {
        clearRetiredWorkingCopyOriginals();
        clearWorkingCopyRevisionInitializations();
        clearPageIdentityStoreInitializations();
    }
    if (skipPaths.size > 0) {
        logger.error(
            `Skipped shutdown deletion for ${skipPaths.size} working copy path(s) with pending writes or dirty sync state: ${
                Array.from(skipPaths).join(', ')
            }`,
        );
    }

    await Promise.allSettled(
        Array.from(retiredPaths, ([
            workingPath,
            originalPath,
        ]) => (
            cleanupWorkingCopyDirectory(workingPath, originalPath)
        )),
    );
}
