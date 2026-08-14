// Public because document opening must distinguish managed cleanup outputs from user files.
import type { App } from 'electron';
import * as electron from 'electron';
import {
    createHash,
    randomUUID,
} from 'crypto';
import {realpathSync} from 'fs';
import {
    mkdir,
    readdir,
    rm,
    stat,
    utimes,
} from 'fs/promises';
import {
    basename,
    dirname,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'path';
import { getAppTempDirPath } from '@electron/utils/appTempDir';

export const SCAN_CLEANUP_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES = 255;
const OUTPUT_NAME_HASH_HEX_LENGTH = 12;

/**
 * Cleanup outputs are the feature's only deliverable, so they live under app
 * data: the OS may purge its temp directory on its own schedule, which would
 * destroy a document the user is still coming back to. Outputs written by
 * earlier versions stay under the app temp directory; that root remains
 * readable and keeps being swept by the same retention policy.
 */
export function getScanCleanupOutputBaseDirs() {
    // The Electron app is reachable from the main process only, which is the
    // only place outputs are created, classified or swept; elsewhere the legacy
    // root is all there is to report.
    const appDataDir = (electron as {app?: Pick<App, 'getPath'>}).app?.getPath('userData');
    const legacyTempDir = getAppTempDirPath();
    return appDataDir ? [
        appDataDir,
        legacyTempDir,
    ] : [legacyTempDir];
}

export function getScanCleanupOutputRoot(baseDir = getScanCleanupOutputBaseDirs()[0]!) {
    return join(baseDir, 'scan-cleanup', 'output');
}

export function isScanCleanupGeneratedOutputPath(
    outputPath: string,
    baseDirs: readonly string[] = getScanCleanupOutputBaseDirs(),
) {
    return baseDirs.some(baseDir => isPathInsideOutputRoot(outputPath, baseDir));
}

function isPathInsideOutputRoot(outputPath: string, baseDir: string) {
    let relativePath: string;
    try {
        relativePath = relative(
            realpathSync(getScanCleanupOutputRoot(baseDir)),
            realpathSync(outputPath),
        );
    } catch {
        return false;
    }
    const segments = relativePath.split(sep);
    return relativePath.length > 0
        && relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
        && segments.length === 2
        && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(segments[0] ?? '')
        && extname(segments[1] ?? '').toLowerCase() === '.pdf';
}

function utf8Prefix(value: string, maxBytes: number) {
    let bytes = 0;
    let prefix = '';
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (bytes + characterBytes > maxBytes) {
            break;
        }
        prefix += character;
        bytes += characterBytes;
    }
    return prefix;
}

function humanOutputName(sourcePdfPath: string, partial: boolean) {
    const sourceName = basename(sourcePdfPath, extname(sourcePdfPath)).trim() || 'document';
    const suffix = ` — cleaned${partial ? ' selection' : ''}.pdf`;
    const fullName = `${sourceName}${suffix}`;
    if (Buffer.byteLength(fullName, 'utf8') <= SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES) {
        return fullName;
    }
    const sourceHash = createHash('sha256')
        .update(sourceName, 'utf8')
        .digest('hex')
        .slice(0, OUTPUT_NAME_HASH_HEX_LENGTH);
    const disambiguator = `…-${sourceHash}`;
    const prefixBytes = SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES
        - Buffer.byteLength(`${disambiguator}${suffix}`, 'utf8');
    const truncatedSourceName = utf8Prefix(sourceName, prefixBytes).trimEnd();
    return `${truncatedSourceName}${disambiguator}${suffix}`;
}

export async function createScanCleanupGeneratedOutputPath(
    sourcePdfPath: string,
    partial = false,
    baseDir = getScanCleanupOutputBaseDirs()[0]!,
) {
    const outputDirectory = join(getScanCleanupOutputRoot(baseDir), randomUUID());
    await mkdir(outputDirectory, {
        recursive: true,
        mode: 0o700,
    });
    return join(outputDirectory, humanOutputName(sourcePdfPath, partial));
}

/**
 * Retention is measured from last access, not from creation: a document the
 * user keeps opening must never expire underneath them. Opening an output
 * stamps its run directory, which is the same timestamp the sweep reads.
 */
export async function touchScanCleanupGeneratedOutput(
    outputPath: string,
    options: {
        baseDirs?: readonly string[];
        nowMs?: number;
    } = {},
) {
    if (!isScanCleanupGeneratedOutputPath(outputPath, options.baseDirs ?? getScanCleanupOutputBaseDirs())) {
        return false;
    }
    const accessedAtSeconds = (options.nowMs ?? Date.now()) / 1_000;
    try {
        await utimes(dirname(outputPath), accessedAtSeconds, accessedAtSeconds);
        return true;
    } catch {
        // Losing the stamp only shortens retention; it must never fail an open.
        return false;
    }
}

export async function pruneScanCleanupGeneratedOutputs(options: {
    baseDirs?: readonly string[];
    isOutputLive: (outputPath: string) => boolean;
    nowMs?: number;
}) {
    const baseDirs = options.baseDirs ?? getScanCleanupOutputBaseDirs();
    const nowMs = options.nowMs ?? Date.now();
    let removed = 0;
    for (const baseDir of baseDirs) {
        removed += await pruneOutputRoot(getScanCleanupOutputRoot(baseDir), options.isOutputLive, nowMs);
    }
    return removed;
}

async function pruneOutputRoot(
    outputRoot: string,
    isOutputLive: (outputPath: string) => boolean,
    nowMs: number,
) {
    const resolvedRoot = resolve(outputRoot);
    let entries;
    try {
        entries = await readdir(outputRoot, {withFileTypes: true});
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 0;
        }
        throw error;
    }

    let removed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const directoryPath = join(outputRoot, entry.name);
        const resolvedDirectory = resolve(directoryPath);
        if (!resolvedDirectory.startsWith(`${resolvedRoot}${process.platform === 'win32' ? '\\' : '/'}`)) continue;
        const files = await readdir(directoryPath, {withFileTypes: true}).catch(() => []);
        const outputPdfPaths = files
            .filter(file => file.isFile() && extname(file.name).toLowerCase() === '.pdf')
            .map(file => join(directoryPath, file.name));
        if (containsLiveOutput(outputPdfPaths, isOutputLive)) continue;
        const metadata = await stat(directoryPath).catch(() => null);
        if (!metadata || nowMs - metadata.mtimeMs < SCAN_CLEANUP_OUTPUT_MAX_AGE_MS) continue;
        // Liveness can change while directory metadata is being read. Check
        // the main-owned registry again at the last synchronous decision point
        // before rm is submitted, so an output opened during a prune survives.
        if (containsLiveOutput(outputPdfPaths, isOutputLive)) continue;
        await rm(directoryPath, {
            recursive: true,
            force: true,
        });
        removed += 1;
    }
    return removed;
}

function containsLiveOutput(
    outputPdfPaths: readonly string[],
    isOutputLive: (outputPath: string) => boolean,
) {
    for (const outputPdfPath of outputPdfPaths) {
        if (isOutputLive(outputPdfPath)) {
            return true;
        }
    }
    return false;
}
