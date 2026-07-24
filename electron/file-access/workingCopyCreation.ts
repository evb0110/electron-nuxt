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
import {
    copyFile,
    writeFile,
} from 'fs/promises';
import {
    decryptPdfFileIfNeeded,
    isPdfFileEncrypted,
} from '@electron/utils/decryptPdfFileIfNeeded';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import {
    attemptWorkingCopyClone,
    copyFileCopyOnWrite,
    createWorkingDirectory,
    isWorkingCopyDirectoryName,
    safeRemoveDirectory,
} from '@electron/file-access/workingCopyDirectory';
import {
    captureWorkingCopyAdmissionSnapshot,
    forgetRetiredWorkingCopyOriginal,
    getWorkingCopyOriginalPath,
    getWorkingCopyRole,
    isKnownWorkingCopyOriginalPath,
    setWorkingCopyOriginalPath,
    type TWorkingCopyRole,
    workingCopyAdmissionSnapshotsMatch,
} from '@electron/file-access/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';
import { WorkingCopyMissingError } from '@electron/file-access/workingCopyMissingError';
import { createLogger } from '@electron/utils/createLogger';
import { getAppTempDir } from '@electron/utils/appTempDir';
import {
    ensureWorkingCopyRevision,
    initializeFreshWorkingCopyRevision,
    markWorkingCopyContentChanged,
} from '@electron/file-access/documentRevisionStore';
import { readWorkingCopySyncRequiredJournalEntry } from '@electron/file-access/documentRevisionSidecar';
import {schedulePageIdentityStoreInitialization} from '@electron/file-access/pageIdentityStore';
import {
    startBackgroundWorkingCopyMaterialization,
    WorkingCopyMaterializationError,
} from '@electron/file-access/workingCopyMaterialization';

const logger = createLogger('working-copy');

interface IWorkingCopyPhaseTiming {
    durationMs: number;
    phase: string;
}

type TWorkingCopyMaterializationMode = 'eager' | 'background' | 'lazy';

function getWorkingCopyMaterializationMode(): TWorkingCopyMaterializationMode {
    const configuredMode = process.env.EVB_WORKING_COPY_MATERIALIZATION_MODE ?? 'background';
    return configuredMode === 'eager' || configuredMode === 'lazy'
        ? configuredMode
        : 'background';
}

async function measureWorkingCopyPhase<T>(
    timings: IWorkingCopyPhaseTiming[],
    phase: string,
    operation: () => Promise<T>,
) {
    const startedAt = performance.now();
    try {
        return await operation();
    } finally {
        timings.push({
            durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
            phase,
        });
    }
}

function resolveWorkingCopyRoleForPathClone(
    sourcePath: string,
    ownerWebContentsId?: number,
): TWorkingCopyRole {
    return getWorkingCopyOriginalPath(sourcePath, ownerWebContentsId) ? 'snapshot' : 'current';
}

export async function createWorkingCopy(originalPath: TOpenPath, ownerWebContentsId?: number) {
    const operationStartedAt = performance.now();
    const phaseTimings: IWorkingCopyPhaseTiming[] = [];
    const workDir = createWorkingDirectory();
    try {
        const fileName = basename(originalPath);
        const workingPath = join(workDir, fileName);
        const isPdf = workingPath.toLowerCase().endsWith('.pdf');
        const materializationMode = getWorkingCopyMaterializationMode();
        let admissionSnapshot: Awaited<ReturnType<typeof captureWorkingCopyAdmissionSnapshot>> | undefined;
        let backingState: 'cloned' | 'eager' | 'lazy-original';
        let encrypted = false;

        if (materializationMode === 'eager') {
            const cloneOutcome = await measureWorkingCopyPhase(phaseTimings, 'copy-on-write', () =>
                attemptWorkingCopyClone(originalPath, workingPath));
            if (cloneOutcome === 'known-unsupported') {
                await measureWorkingCopyPhase(phaseTimings, 'eager-copy', () =>
                    copyFile(originalPath, workingPath));
            }
            if (isPdf) {
                encrypted = await measureWorkingCopyPhase(phaseTimings, 'encryption-probe', () =>
                    decryptPdfFileIfNeeded(workingPath));
            }
            backingState = cloneOutcome === 'cloned' && !encrypted ? 'cloned' : 'eager';
        } else {
            const cloneOutcome = await measureWorkingCopyPhase(phaseTimings, 'copy-on-write', () =>
                attemptWorkingCopyClone(originalPath, workingPath));
            if (cloneOutcome === 'known-unsupported') {
                const beforeProbe = await measureWorkingCopyPhase(phaseTimings, 'source-stat-before-probe', () =>
                    captureWorkingCopyAdmissionSnapshot(originalPath));
                encrypted = isPdf
                    ? await measureWorkingCopyPhase(phaseTimings, 'encryption-probe', () =>
                        isPdfFileEncrypted(originalPath))
                    : false;
                const afterProbe = await measureWorkingCopyPhase(phaseTimings, 'source-stat-after-probe', () =>
                    captureWorkingCopyAdmissionSnapshot(originalPath));
                if (!workingCopyAdmissionSnapshotsMatch(beforeProbe, afterProbe)) {
                    throw new WorkingCopyMaterializationError(
                        'SOURCE_BACKING_CHANGED',
                        'The original document changed while it was being opened',
                    );
                }
                admissionSnapshot = afterProbe;
                if (encrypted || !isPdf) {
                    await measureWorkingCopyPhase(phaseTimings, 'eager-copy', () =>
                        copyFile(originalPath, workingPath));
                    if (isPdf) {
                        await measureWorkingCopyPhase(phaseTimings, 'decrypt', () =>
                            decryptPdfFileIfNeeded(workingPath));
                    }
                    backingState = 'eager';
                } else {
                    backingState = 'lazy-original';
                }
            } else {
                if (isPdf) {
                    encrypted = await measureWorkingCopyPhase(phaseTimings, 'encryption-probe', () =>
                        decryptPdfFileIfNeeded(workingPath));
                }
                backingState = cloneOutcome === 'cloned' && !encrypted ? 'cloned' : 'eager';
            }
        }

        await measureWorkingCopyPhase(phaseTimings, 'register-source', () => setWorkingCopyOriginalPath(
            workingPath,
            originalPath,
            ownerWebContentsId,
            {
                ...(admissionSnapshot ? {admissionSnapshot} : {}),
                backingState,
                deferOriginalFileExpectation: !encrypted,
            },
        ));
        const revision = await measureWorkingCopyPhase(phaseTimings, 'revision-sidecar', () =>
            initializeFreshWorkingCopyRevision(workingPath, ownerWebContentsId));
        if (isPdf) {
            void schedulePageIdentityStoreInitialization(workingPath, revision, originalPath);
        }
        if (backingState === 'lazy-original' && materializationMode === 'background') {
            const backgroundMaterialization = startBackgroundWorkingCopyMaterialization(
                workingPath,
                ownerWebContentsId,
            );
            void backgroundMaterialization?.promise.catch(error => {
                logger.warn(`Background working-copy materialization failed: ${String(error)}`);
            });
        }

        logger.debug(`Working copy source-critical timings: ${JSON.stringify({
            deferredUntilNeeded: [
                'original-file-expectation-on-save',
                'page-identity-on-mutation',
            ],
            backingState,
            materializationMode,
            phases: phaseTimings,
            totalMs: Math.round((performance.now() - operationStartedAt) * 10) / 10,
            workingPath,
        })}`);
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
        await setWorkingCopyOriginalPath(workingPath, mappedOriginalPath, ownerWebContentsId, {
            backingState: 'eager',
            deferOriginalFileExpectation: true,
            role,
        });
        const revision = await initializeFreshWorkingCopyRevision(workingPath, ownerWebContentsId);
        void schedulePageIdentityStoreInitialization(workingPath, revision, sourcePath);

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
            await setWorkingCopyOriginalPath(workingPath, normalizedOriginalPath, ownerWebContentsId, {
                backingState: 'eager',
                deferOriginalFileExpectation: true,
                role,
            });
        }
        const revision = await initializeFreshWorkingCopyRevision(workingPath, ownerWebContentsId);
        void schedulePageIdentityStoreInitialization(workingPath, revision);

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
    if (normalizedWorkingPath.toLowerCase().endsWith('.pdf')) {
        const revision = await ensureWorkingCopyRevision(normalizedWorkingPath, senderWebContentsId);
        void schedulePageIdentityStoreInitialization(normalizedWorkingPath, revision, originalPath);
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
