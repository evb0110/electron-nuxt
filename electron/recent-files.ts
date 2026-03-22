import { statSync } from 'fs';
import {
    readFile,
    rename,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    join,
    basename,
} from 'path';
import { app } from 'electron';
import type { IRecentFile } from '@contracts/shared';
import {
    CACHE_TTL_MS,
    MAX_RECENT_FILES,
} from '@electron/config/constants';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('recent-files');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

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

function getStoragePath(): string {
    return join(app.getPath('userData'), 'recent-files.json');
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
    const files = Array.isArray(parsed.files)
        ? parsed.files.filter((candidate): candidate is IRecentFile => (
            Boolean(candidate)
            && typeof candidate === 'object'
            && typeof (candidate as IRecentFile).originalPath === 'string'
            && typeof (candidate as IRecentFile).fileName === 'string'
            && typeof (candidate as IRecentFile).timestamp === 'number'
            && typeof (candidate as IRecentFile).fileSize === 'number'
        ))
        : [];

    return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        files,
    };
}

function inspectPath(filePath: string): 'exists' | 'missing' | 'unreadable' {
    try {
        statSync(filePath);
        return 'exists';
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return 'missing';
        }
        logger.warn(`Recent file path unreadable; preserving entry (${filePath}): ${error instanceof Error ? error.message : String(error)}`);
        return 'unreadable';
    }
}

function filterExistingFiles(files: IRecentFile[]): IFilteredRecentFiles {
    let removedMissingCount = 0;
    let unreadableCount = 0;
    const checks = files.map((file) => {
        const status = inspectPath(file.originalPath);
        if (status === 'missing') {
            removedMissingCount += 1;
            return null;
        }
        if (status === 'unreadable') {
            unreadableCount += 1;
        }
        return file;
    });

    return {
        files: checks.filter((file): file is IRecentFile => file !== null),
        removedMissingCount,
        unreadableCount,
    };
}

async function loadRecentFilesData(): Promise<IRecentFilesData> {
    const storagePath = getStoragePath();
    try {
        const content = await readFile(storagePath, 'utf-8');
        return normalizeRecentFilesData(JSON.parse(content));
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return {
                version: 1,
                files: [],
            };
        }
        logger.error(`Failed to load recent files: ${err instanceof Error ? err.message : String(err)}`);
        return {
            version: 1,
            files: [],
        };
    }
}

async function saveRecentFilesData(data: IRecentFilesData): Promise<void> {
    const storagePath = getStoragePath();
    const tempPath = `${storagePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
        await rename(tempPath, storagePath);
    } catch (err) {
        logger.error(`Failed to save recent files: ${err instanceof Error ? err.message : String(err)}`);
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

export async function addRecentFile(originalPath: string): Promise<void> {
    await enqueueMutation(async () => {
        // Invalidate cache before mutation
        cacheTimestamp = 0;

        if (!originalPath) {
            return;
        }

        // Get file info with race-safe stat
        let fileSize: number;
        try {
            const st = statSync(originalPath);
            fileSize = st.size;
        } catch {
            // File doesn't exist or became unreadable
            return;
        }

        const data = await loadRecentFilesData();

        // Remove if already exists (to update timestamp)
        data.files = data.files.filter(f => f.originalPath !== originalPath);

        // Get file info
        const fileName = basename(originalPath);

        // Add to front
        data.files.unshift({
            originalPath,
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
        const filtered = filterExistingFiles(recentFilesCache);
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] recent-files:get cache hit (${filtered.files.length} file(s), removedMissing=${filtered.removedMissingCount}, unreadable=${filtered.unreadableCount}, +${Date.now() - startedAt}ms)`);
        }
        return filtered.files;
    }

    // Refresh cache from disk
    const data = await loadRecentFilesData();
    const filtered = filterExistingFiles(data.files);
    const validFiles = filtered.files;

    // Update cache
    recentFilesCache = validFiles;
    cacheTimestamp = Date.now();

    if (STARTUP_TRACE_ENABLED) {
        logger.info(`[startup] recent-files:get disk refresh (${validFiles.length} file(s), removedMissing=${filtered.removedMissingCount}, unreadable=${filtered.unreadableCount}, +${Date.now() - startedAt}ms)`);
    }
    return validFiles;
}

export async function removeRecentFile(originalPath: string): Promise<void> {
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

export async function clearRecentFiles(): Promise<void> {
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
export async function initRecentFilesCache(): Promise<void> {
    await mutationQueue;
    const files = await getRecentFiles();
    recentFilesCache = files;
}
