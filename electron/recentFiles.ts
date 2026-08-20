import {
    readFile,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    join,
    basename,
    dirname,
    win32,
} from 'path';
import { app } from 'electron';
import {
    uniq,
    uniqBy,
} from 'es-toolkit/array';
import type { IRecentFile } from '@contracts/shared';
import {
    inferDocumentRefBackend,
    isNativeLegacyDocumentRef,
} from '@contracts/documentRef';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    CACHE_TTL_MS,
    MAX_RECENT_FILES,
} from '@electron/config/constants';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { quarantineCorruptFile } from '@electron/utils/quarantineCorruptFile';
import { isWorkingCopyDirectoryName } from '@electron/file-access/workingCopyDirectory';
import {
    getWorkingCopyOriginalPath,
    getWorkingCopyOriginalPathForPersistence,
    normalizePathForLookup,
} from '@electron/file-access/workingCopyStore';
import {
    getAppTempDirPath,
    getLegacyAppTempDirPath,
} from '@electron/utils/appTempDir';

const logger = createLogger('recentFiles');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';
const BOOTSTRAP_DEV_PROFILE_ENABLED = process.env.EVB_AUTOMATION_BOOTSTRAP_DEV_PROFILE === '1';
const RECENT_FILE_STAT_TIMEOUT_MS = parseIntegerEnv('EVB_RECENT_FILE_STAT_TIMEOUT_MS', 1_500, 100, 60_000);
const BOOTSTRAP_RECENT_FILES_DIR_NAMES = [
    'EVB Viewer Dev',
    'EVB Viewer',
    'EVB-Viewer',
    'Electron',
] as const;

// In-memory cache for synchronous access (needed for menu building)
let recentFilesCache: IRecentFile[] = [];
let cacheTimestamp = 0;
let recentFilesRefreshPromise: Promise<IRecentFile[]> | null = null;
let recentFilesOperationQueue: Promise<unknown> = Promise.resolve();

interface IRecentFilesData {
    version: number;
    files: IRecentFile[];
}

interface IFilteredRecentFiles {
    files: IRecentFile[];
    removedMissingCount: number;
    unreadableCount: number;
}

interface IPathInspectionResult {
    status: 'exists' | 'missing' | 'unreadable';
    size?: number;
    modifiedAt?: number;
}

class RecentFileStatTimeoutError extends Error {
    readonly filePath: string;
    readonly timeoutMs: number;

    constructor(filePath: string, timeoutMs: number) {
        super(`Timed out while checking recent file path after ${timeoutMs}ms: ${filePath}`);
        this.name = 'RecentFileStatTimeoutError';
        this.filePath = filePath;
        this.timeoutMs = timeoutMs;
    }
}

function getStoragePath() {
    return join(app.getPath('userData'), 'recentFiles.json');
}

function getBootstrapStoragePaths() {
    if (!BOOTSTRAP_DEV_PROFILE_ENABLED) {
        return [];
    }

    const appDataPath = app.getPath('appData');
    const currentStoragePath = getStoragePath();
    return uniq(BOOTSTRAP_RECENT_FILES_DIR_NAMES
        .map(dirName => join(appDataPath, dirName, 'recentFiles.json'))
        .filter(candidatePath => candidatePath !== currentStoragePath));
}

function normalizeRecentFilesData(raw: unknown): IRecentFilesData {
    if (!raw || typeof raw !== 'object') {
        return {
            version: 1,
            files: [],
        };
    }

    const parsed = raw as {
        version?: unknown;
        files?: unknown;
    };
    const files: IRecentFile[] = [];
    if (Array.isArray(parsed.files)) {
        for (const candidate of parsed.files) {
            if (!isRecord(candidate)) {
                continue;
            }
            const originalPath = candidate.originalPath;
            const fileName = candidate.fileName;
            const timestamp = candidate.timestamp;
            const fileSize = candidate.fileSize;
            const modifiedAt = candidate.modifiedAt;
            const backend = candidate.backend;
            if (
                typeof originalPath === 'string'
                && isNativeLegacyDocumentRef(originalPath)
                && typeof fileName === 'string'
                && typeof timestamp === 'number'
                && typeof fileSize === 'number'
                && (modifiedAt === undefined || (
                    typeof modifiedAt === 'number'
                    && Number.isSafeInteger(modifiedAt) && modifiedAt >= 0
                ))
                && (backend === undefined || backend === 'electron')
                && inferDocumentRefBackend(originalPath) === 'electron'
            ) {
                files.push({
                    originalPath,
                    backend: 'electron',
                    fileName,
                    timestamp,
                    fileSize,
                    ...(typeof modifiedAt === 'number' ? {modifiedAt} : {}),
                });
            }
        }
    }

    return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        files,
    };
}

async function statWithTimeout(filePath: string) {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            stat(filePath),
            new Promise<never>((_resolve, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new RecentFileStatTimeoutError(filePath, RECENT_FILE_STAT_TIMEOUT_MS));
                }, RECENT_FILE_STAT_TIMEOUT_MS);
                timeoutHandle.unref?.();
            }),
        ]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

async function inspectPath(filePath: string): Promise<IPathInspectionResult> {
    try {
        const fileStat = await statWithTimeout(filePath);
        return {
            status: 'exists',
            size: fileStat.size,
            modifiedAt: Math.trunc(fileStat.mtimeMs),
        };
    } catch (error) {
        const code = isErrnoException(error) ? error.code : undefined;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return {status: 'missing'};
        }
        const timedOut = error instanceof RecentFileStatTimeoutError;
        logger.warn(
            timedOut
                ? `Recent file path stat timed out; preserving entry (${filePath})`
                : `Recent file path unreadable; preserving entry (${filePath}): ${getErrorMessage(error)}`,
        );
        return {status: 'unreadable'};
    }
}

async function filterExistingFiles(files: IRecentFile[]): Promise<IFilteredRecentFiles> {
    let removedMissingCount = 0;
    let unreadableCount = 0;
    const checks: IRecentFile[] = [];
    const nativeFiles = files.filter(file => isNativeLegacyDocumentRef(file.originalPath));
    removedMissingCount += files.length - nativeFiles.length;
    const inspections = await Promise.all(uniqBy(nativeFiles, item => item.originalPath).map(async (file) => ({
        file,
        inspection: await inspectPath(file.originalPath),
    })));

    for (const {
        file,
        inspection,
    } of inspections) {
        if (inspection.status === 'missing') {
            removedMissingCount += 1;
            continue;
        }
        if (inspection.status === 'unreadable') {
            unreadableCount += 1;
        }
        checks.push(inspection.status === 'exists'
            ? {
                ...file,
                ...(inspection.size === undefined ? {} : {fileSize: inspection.size}),
                ...(inspection.modifiedAt === undefined ? {} : {modifiedAt: inspection.modifiedAt}),
            }
            : file);
    }

    return {
        files: checks,
        removedMissingCount,
        unreadableCount,
    };
}

function emptyRecentFilesData(): IRecentFilesData {
    return {
        version: 1,
        files: [],
    };
}

async function tryBootstrapRecentFiles(bootstrapPath: string): Promise<IRecentFilesData | null> {
    try {
        const content = await readFile(bootstrapPath, 'utf-8');
        const parsed: unknown = JSON.parse(content);
        const bootstrapData = normalizeRecentFilesData(parsed);
        const canonicalized = canonicalizePersistedRecentFiles(bootstrapData.files);
        bootstrapData.files = canonicalized.files;
        const filtered = await filterExistingFiles(bootstrapData.files);
        if (filtered.files.length === 0) {
            return null;
        }

        const migratedData = {
            ...bootstrapData,
            files: filtered.files,
        };
        await saveRecentFilesData(migratedData);
        if (STARTUP_TRACE_ENABLED) {
            logger.info(
                `[startup] recentFiles bootstrap (${filtered.files.length} file(s) from ${bootstrapPath}, `
                + `removedMissing=${filtered.removedMissingCount}, unreadable=${filtered.unreadableCount})`,
            );
        }
        return migratedData;
    } catch (bootstrapError) {
        if (!isErrnoException(bootstrapError) || bootstrapError.code !== 'ENOENT') {
            logger.warn(
                `Failed to bootstrap recent files from ${bootstrapPath}: ${
                    getErrorMessage(bootstrapError)
                }`,
            );
        }
        return null;
    }
}

async function loadBootstrapRecentFilesData(): Promise<IRecentFilesData | null> {
    for (const bootstrapPath of getBootstrapStoragePaths()) {
        const bootstrapData = await tryBootstrapRecentFiles(bootstrapPath);
        if (bootstrapData) {
            return bootstrapData;
        }
    }

    return null;
}

async function loadRecentFilesData(): Promise<IRecentFilesData> {
    const storagePath = getStoragePath();
    let content: string;
    try {
        content = await readFile(storagePath, 'utf-8');
    } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') {
            const bootstrapData = await loadBootstrapRecentFilesData();
            return bootstrapData ?? emptyRecentFilesData();
        }
        logger.error(`Failed to read recent files: ${getErrorMessage(err)}`);
        return emptyRecentFilesData();
    }

    try {
        const parsed: unknown = JSON.parse(content);
        const normalizedData = normalizeRecentFilesData(parsed);
        const canonicalized = canonicalizePersistedRecentFiles(normalizedData.files);
        if (canonicalized.changed) {
            normalizedData.files = canonicalized.files;
            await saveRecentFilesData(normalizedData);
        }
        return normalizedData;
    } catch (err) {
        logger.error(`Failed to load recent files: ${getErrorMessage(err)}`);
        const emptyData = emptyRecentFilesData();
        try {
            const quarantinePath = await quarantineCorruptFile(storagePath);
            await saveRecentFilesData(emptyData);
            logger.warn(`Quarantined corrupt recent-files state at ${quarantinePath ?? storagePath}`);
        } catch (recoveryError) {
            logger.error(`Failed to recover corrupt recent files: ${getErrorMessage(recoveryError)}`);
        }
        return emptyData;
    }
}

async function saveRecentFilesData(data: IRecentFilesData) {
    const storagePath = getStoragePath();
    const tempPath = makeSiblingTempPath(storagePath);
    try {
        await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
        await atomicReplace(tempPath, storagePath);
    } catch (err) {
        logger.error(`Failed to save recent files: ${getErrorMessage(err)}`);
        try {
            await unlink(tempPath);
        } catch {
            // Best-effort temp file cleanup.
        }
        throw err;
    }
}

function cloneRecentFiles(files: readonly IRecentFile[]): IRecentFile[] {
    return files.map(file => ({...file}));
}

function recentFilesEqual(left: readonly IRecentFile[], right: readonly IRecentFile[]) {
    return left.length === right.length && left.every((file, index) => {
        const other = right[index];
        return other !== undefined
            && file.originalPath === other.originalPath
            && file.backend === other.backend
            && file.fileName === other.fileName
            && file.timestamp === other.timestamp
            && file.fileSize === other.fileSize
            && file.modifiedAt === other.modifiedAt;
    });
}

function enqueueRecentFilesOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = recentFilesOperationQueue.then(operation, operation);
    recentFilesOperationQueue = run.then(() => undefined, () => undefined);
    return run;
}

function refreshRecentFilesCache(): Promise<IRecentFile[]> {
    if (recentFilesRefreshPromise) {
        return recentFilesRefreshPromise;
    }

    const refreshPromise = enqueueRecentFilesOperation(async () => {
        const data = await loadRecentFilesData();
        const filtered = await filterExistingFiles(data.files);
        if (!recentFilesEqual(data.files, filtered.files)) {
            data.files = filtered.files;
            await saveRecentFilesData(data);
        }
        recentFilesCache = cloneRecentFiles(filtered.files);
        cacheTimestamp = Date.now();
        if (STARTUP_TRACE_ENABLED) {
            logger.info(
                `[startup] recentFiles:get disk refresh (${filtered.files.length} file(s), `
                + `removedMissing=${filtered.removedMissingCount}, unreadable=${filtered.unreadableCount})`,
            );
        }
        return cloneRecentFiles(recentFilesCache);
    });
    recentFilesRefreshPromise = refreshPromise;
    void refreshPromise.finally(() => {
        if (recentFilesRefreshPromise === refreshPromise) {
            recentFilesRefreshPromise = null;
        }
    }).catch(() => {});
    return refreshPromise;
}

function resolveRecentOriginalPath(filePath: string, senderWebContentsId?: number) {
    const mappedOriginalPath = (
        typeof senderWebContentsId === 'number'
            ? getWorkingCopyOriginalPath(filePath, senderWebContentsId)
            : getWorkingCopyOriginalPathForPersistence(filePath)
    )?.originalPath;
    if (mappedOriginalPath) {
        return mappedOriginalPath;
    }

    // Internal working copies are implementation details, not user documents. If
    // their ownership mapping has already expired, dropping the entry is safer
    // than leaking a volatile temp path into persistent Recent Files state.
    const parentPath = normalizePathForLookup(dirname(filePath));
    const windowsPath = /^[a-zA-Z]:[\\/]/.test(parentPath) || parentPath.startsWith('\\\\');
    const pathDirname = windowsPath ? win32.dirname : dirname;
    const pathBasename = windowsPath ? win32.basename : basename;
    const appTempParent = pathDirname(parentPath);
    const normalizedCurrentTemp = normalizePathForLookup(getAppTempDirPath());
    const normalizedLegacyTemp = normalizePathForLookup(getLegacyAppTempDirPath());
    const legacyTempParent = pathDirname(normalizedLegacyTemp);
    const isKnownAppTemp = appTempParent === normalizedCurrentTemp
        || appTempParent === normalizedLegacyTemp;
    const isAnotherProfileAppTemp = pathDirname(appTempParent) === legacyTempParent
        && pathBasename(appTempParent).startsWith(`${pathBasename(normalizedLegacyTemp)}-`);
    if (
        (isKnownAppTemp || isAnotherProfileAppTemp)
        && isWorkingCopyDirectoryName(pathBasename(parentPath))
    ) {
        logger.warn(`Refusing to persist unmapped managed working-copy path as recent: ${filePath}`);
        return null;
    }

    return filePath;
}

function canonicalizePersistedRecentFiles(files: IRecentFile[]) {
    const canonicalFiles: IRecentFile[] = [];
    const seenPaths = new Set<string>();
    let changed = false;
    for (const file of files) {
        const originalPath = resolveRecentOriginalPath(file.originalPath);
        if (!originalPath) {
            changed = true;
            continue;
        }
        if (seenPaths.has(originalPath)) {
            changed = true;
            continue;
        }
        seenPaths.add(originalPath);
        if (originalPath === file.originalPath) {
            canonicalFiles.push(file);
            continue;
        }
        changed = true;
        canonicalFiles.push({
            ...file,
            originalPath,
            fileName: basename(originalPath),
        });
    }
    return {
        changed,
        files: canonicalFiles,
    };
}

/** Persists a recent-file entry; callers must validate or mint path capabilities before calling. */
export async function addRecentFile(filePath: string, senderWebContentsId?: number) {
    await enqueueRecentFilesOperation(async () => {
        // Invalidate cache before mutation
        cacheTimestamp = 0;

        if (!filePath) {
            return;
        }

        const originalPath = resolveRecentOriginalPath(filePath, senderWebContentsId);
        if (!originalPath) {
            return;
        }

        const inspection = await inspectPath(originalPath);
        if (inspection.status !== 'exists' || typeof inspection.size !== 'number') {
            return;
        }
        const fileSize = inspection.size;
        const modifiedAt = inspection.modifiedAt;

        const data = await loadRecentFilesData();

        // Remove if already exists (to update timestamp)
        data.files = data.files.filter(f => f.originalPath !== originalPath);

        // Get file info
        const fileName = basename(originalPath);

        // Add to front
        data.files.unshift({
            originalPath,
            backend: 'electron',
            fileName,
            timestamp: Date.now(),
            fileSize,
            ...(modifiedAt === undefined ? {} : {modifiedAt}),
        });

        // Enforce limit
        if (data.files.length > MAX_RECENT_FILES) {
            data.files = data.files.slice(0, MAX_RECENT_FILES);
        }

        await saveRecentFilesData(data);

        // Update cache
        recentFilesCache = cloneRecentFiles(data.files);
        cacheTimestamp = Date.now();
    });
}

export async function getRecentFiles(): Promise<IRecentFile[]> {
    const startedAt = Date.now();
    const operationsAtCallTime = recentFilesOperationQueue;
    await operationsAtCallTime;
    if (Date.now() - cacheTimestamp < CACHE_TTL_MS) {
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] recentFiles:get cache hit (${recentFilesCache.length} file(s), +${Date.now() - startedAt}ms)`);
        }
        return cloneRecentFiles(recentFilesCache);
    }

    return cloneRecentFiles(await refreshRecentFilesCache());
}

export async function removeRecentFile(originalPath: string) {
    await enqueueRecentFilesOperation(async () => {
        // Invalidate cache before mutation
        cacheTimestamp = 0;

        const data = await loadRecentFilesData();
        data.files = data.files.filter(f => f.originalPath !== originalPath);
        await saveRecentFilesData(data);

        // Update cache
        recentFilesCache = cloneRecentFiles(data.files);
        cacheTimestamp = Date.now();
    });
}

export async function removeRecentFileIfMissing(originalPath: string) {
    return enqueueRecentFilesOperation(async () => {
        const data = await loadRecentFilesData();
        if (!data.files.some(file => file.originalPath === originalPath)) {
            return false;
        }

        const inspection = await inspectPath(originalPath);
        if (inspection.status !== 'missing') {
            return false;
        }

        data.files = data.files.filter(file => file.originalPath !== originalPath);
        await saveRecentFilesData(data);
        recentFilesCache = cloneRecentFiles(data.files);
        cacheTimestamp = Date.now();
        return true;
    });
}

export async function clearRecentFiles() {
    await enqueueRecentFilesOperation(async () => {
        // Invalidate cache before mutation
        cacheTimestamp = 0;
        recentFilesCache = [];

        await saveRecentFilesData({
            version: 1,
            files: [],
        });
        cacheTimestamp = Date.now();
    });
}

/**
 * Get recent files synchronously from cache (for menu building)
 * Returns array of file paths
 */
export function getRecentFilesSync(): string[] {
    return recentFilesCache.map(f => f.originalPath);
}

/**
 * Initialize the recent files cache
 * Call this during app startup before menu is built
 */
export async function initRecentFilesCache(): Promise<void> {
    await refreshRecentFilesCache();
}
