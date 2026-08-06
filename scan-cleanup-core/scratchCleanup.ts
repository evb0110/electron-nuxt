import {
    lstat,
    mkdtemp,
    readdir,
    rm,
} from 'node:fs/promises';
import {join} from 'node:path';
import {getErrorMessage} from '@contracts/getErrorMessage';

export const SCAN_CLEANUP_SCRATCH_PREFIX = 'scan-cleanup-';
export const SCAN_CLEANUP_SCRATCH_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface IScanCleanupScratchDirectoryEntry {
    name: string;
    isDirectory: () => boolean;
}

export interface IScanCleanupScratchFileSystem {
    lstat: (path: string) => Promise<{
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
        mtimeMs: number
    }>;
    readdir: (path: string) => Promise<readonly IScanCleanupScratchDirectoryEntry[]>;
    rm: (path: string, options: {
        force: boolean;
        recursive: boolean
    }) => Promise<void>;
}

export interface IScanCleanupScratchSweepOptions {
    fileSystem?: Partial<IScanCleanupScratchFileSystem>;
    log?: (level: 'debug' | 'warn', message: string) => void;
    maxAgeMs?: number;
    now?: () => number;
}

const defaultFileSystem: IScanCleanupScratchFileSystem = {
    lstat: async path => lstat(path),
    readdir: path => readdir(path, {withFileTypes: true}),
    rm: async (path, options) => rm(path, options),
};

export async function sweepStaleScanCleanupScratchDirs(
    parentPath: string,
    options: IScanCleanupScratchSweepOptions = {},
) {
    const fileSystem: IScanCleanupScratchFileSystem = {
        ...defaultFileSystem,
        ...options.fileSystem,
    };
    const log = options.log ?? (() => undefined);
    const now = options.now ?? Date.now;
    const maxAgeMs = options.maxAgeMs ?? SCAN_CLEANUP_SCRATCH_STALE_MAX_AGE_MS;
    let entries: readonly IScanCleanupScratchDirectoryEntry[];
    try {
        entries = await fileSystem.readdir(parentPath);
    } catch (error) {
        log('warn', `Could not sweep scan-cleanup scratch parent "${parentPath}": ${getErrorMessage(error)}`);
        return 0;
    }

    let removedCount = 0;
    for (const entry of entries) {
        if (!entry.name.startsWith(SCAN_CLEANUP_SCRATCH_PREFIX) || !entry.isDirectory()) {
            continue;
        }
        const scratchPath = join(parentPath, entry.name);
        try {
            const scratchStat = await fileSystem.lstat(scratchPath);
            if (
                !scratchStat.isDirectory()
                || scratchStat.isSymbolicLink()
                || now() - scratchStat.mtimeMs < maxAgeMs
            ) {
                continue;
            }
            await fileSystem.rm(scratchPath, {
                force: true,
                recursive: true,
            });
            removedCount += 1;
            log('debug', `Removed stale scan-cleanup scratch directory "${scratchPath}"`);
        } catch (error) {
            log('warn', `Could not remove stale scan-cleanup scratch directory "${scratchPath}": ${getErrorMessage(error)}`);
        }
    }
    return removedCount;
}

export async function createScanCleanupScratchDir(
    parentPath: string,
    prefix = SCAN_CLEANUP_SCRATCH_PREFIX,
) {
    return mkdtemp(join(parentPath, prefix));
}
