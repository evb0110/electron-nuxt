import {
    readFile,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    join,
    basename,
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
let mutationQueue: Promise<void> = Promise.resolve();

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
            if (
                isRecord(candidate)
                && typeof candidate.originalPath === 'string'
                && isNativeLegacyDocumentRef(candidate.originalPath)
                && typeof candidate.fileName === 'string'
                && typeof candidate.timestamp === 'number'
                && typeof candidate.fileSize === 'number'
                && (candidate.backend === undefined || candidate.backend === 'electron')
                && inferDocumentRefBackend(candidate.originalPath) === 'electron'
            ) {
                files.push({
                    originalPath: candidate.originalPath,
                    backend: 'electron',
                    fileName: candidate.fileName,
                    timestamp: candidate.timestamp,
                    fileSize: candidate.fileSize,
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
        checks.push(file);
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
        return normalizeRecentFilesData(parsed);
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

function enqueueMutation(task: () => Promise<void>) {
    const run = mutationQueue.then(task, task);
    mutationQueue = run.then(() => undefined, () => undefined);
    return run;
}

/** Persists a recent-file entry; callers must validate or mint path capabilities before calling. */
export async function addRecentFile(originalPath: string) {
    await enqueueMutation(async () => {
        // Invalidate cache before mutation
        cacheTimestamp = 0;

        if (!originalPath) {
            return;
        }

        const inspection = await inspectPath(originalPath);
        if (inspection.status !== 'exists' || typeof inspection.size !== 'number') {
            return;
        }
        const fileSize = inspection.size;

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
        });

        // Enforce limit
        if (data.files.length > MAX_RECENT_FILES) {
            data.files = data.files.slice(0, MAX_RECENT_FILES);
        }

        await saveRecentFilesData(data);

        // Update cache
        recentFilesCache = data.files;
        cacheTimestamp = Date.now();
    });
}

export async function getRecentFiles(): Promise<IRecentFile[]> {
    const startedAt = Date.now();
    await mutationQueue;
    // Use cache if fresh
    if (Date.now() - cacheTimestamp < CACHE_TTL_MS) {
        // Still validate existence
        const filtered = await filterExistingFiles(recentFilesCache);
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] recentFiles:get cache hit (${filtered.files.length} file(s), removedMissing=${filtered.removedMissingCount}, unreadable=${filtered.unreadableCount}, +${Date.now() - startedAt}ms)`);
        }
        return filtered.files;
    }

    // Refresh cache from disk
    const data = await loadRecentFilesData();
    const filtered = await filterExistingFiles(data.files);
    const validFiles = filtered.files;

    // Update cache
    recentFilesCache = validFiles;
    cacheTimestamp = Date.now();

    if (STARTUP_TRACE_ENABLED) {
        logger.info(`[startup] recentFiles:get disk refresh (${validFiles.length} file(s), removedMissing=${filtered.removedMissingCount}, unreadable=${filtered.unreadableCount}, +${Date.now() - startedAt}ms)`);
    }
    return validFiles;
}

export async function removeRecentFile(originalPath: string) {
    await enqueueMutation(async () => {
        // Invalidate cache before mutation
        cacheTimestamp = 0;

        const data = await loadRecentFilesData();
        data.files = data.files.filter(f => f.originalPath !== originalPath);
        await saveRecentFilesData(data);

        // Update cache
        recentFilesCache = data.files;
        cacheTimestamp = Date.now();
    });
}

export async function clearRecentFiles() {
    await enqueueMutation(async () => {
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
export async function initRecentFilesCache() {
    await mutationQueue;
    const files = await getRecentFiles();
    recentFilesCache = files;
}
