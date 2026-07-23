import {
    lstat,
    mkdtemp,
    readdir,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';

const logger = createLogger('managed-scratch-temp');
const MANAGED_SCRATCH_MARKER_FILE = '.evb-managed-scratch.json';
const MANAGED_SCRATCH_PREFIXES = [
    'pdfExport-',
    'pdfExport-scope-',
    'qpdfArgs-',
    'qpdfOutput-',
    'pdf-page-ops-',
    'djvu-image-export-',
    'djvu-tiff-export-',
] as const;
const MANAGED_SCRATCH_STALE_MAX_AGE_MS = parseIntegerEnv(
    'EVB_MANAGED_SCRATCH_STALE_MAX_AGE_MS',
    24 * 60 * 60 * 1000,
    60_000,
);
const MANAGED_SCRATCH_SWEEP_MAX_ENTRIES = parseIntegerEnv(
    'EVB_MANAGED_SCRATCH_SWEEP_MAX_ENTRIES',
    200,
    1,
    5_000,
);

export type TManagedScratchPrefix = typeof MANAGED_SCRATCH_PREFIXES[number];

function isManagedScratchDirectoryName(entryName: string) {
    return MANAGED_SCRATCH_PREFIXES.some(prefix => entryName.startsWith(prefix));
}

async function hasManagedScratchMarker(directoryPath: string) {
    try {
        const markerStat = await stat(join(directoryPath, MANAGED_SCRATCH_MARKER_FILE));
        return markerStat.isFile();
    } catch {
        return false;
    }
}

export async function createManagedScratchTempDir(prefix: TManagedScratchPrefix) {
    const tempDir = await mkdtemp(join(getAppTempDir(), prefix));
    await writeFile(join(tempDir, MANAGED_SCRATCH_MARKER_FILE), `${JSON.stringify({
        createdAt: Date.now(),
        pid: process.pid,
        prefix,
    })}\n`, 'utf8');
    return tempDir;
}

export async function usingManagedScratchScope<T>(
    prefix: TManagedScratchPrefix,
    run: (scratchPath: string) => Promise<T>,
): Promise<T> {
    const scratchPath = await createManagedScratchTempDir(prefix);
    try {
        return await run(scratchPath);
    } finally {
        await rm(scratchPath, {
            force: true,
            recursive: true,
        });
    }
}

export async function sweepStaleManagedScratchTempDirs(
    maxAgeMs = MANAGED_SCRATCH_STALE_MAX_AGE_MS,
    maxEntries = MANAGED_SCRATCH_SWEEP_MAX_ENTRIES,
) {
    const tempDir = getAppTempDir();
    const now = Date.now();
    let deletedCount = 0;

    let entries: string[] = [];
    try {
        entries = await readdir(tempDir);
    } catch {
        return 0;
    }

    for (const entry of entries.slice(0, maxEntries)) {
        if (!isManagedScratchDirectoryName(entry)) {
            continue;
        }

        const scratchPath = join(tempDir, entry);
        try {
            const scratchStat = await lstat(scratchPath);
            if (!scratchStat.isDirectory()) {
                continue;
            }
            if (!await hasManagedScratchMarker(scratchPath)) {
                continue;
            }

            const lastTouchedAt = Math.max(scratchStat.mtimeMs, scratchStat.ctimeMs);
            if (!Number.isFinite(lastTouchedAt) || now - lastTouchedAt < maxAgeMs) {
                continue;
            }

            await rm(scratchPath, {
                force: true,
                recursive: true,
            });
            deletedCount += 1;
        } catch (error) {
            logger.warn(`Failed to remove stale managed scratch directory "${scratchPath}": ${getErrorMessage(error)}`);
        }
    }

    if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} stale managed scratch director${deletedCount === 1 ? 'y' : 'ies'}`);
    }

    return deletedCount;
}
