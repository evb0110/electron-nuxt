import {
    dirname,
    isAbsolute,
    relative,
    resolve,
    sep,
    win32,
} from 'path';
import {
    existsSync,
    lstatSync,
    realpathSync,
} from 'fs';
import {
    lstat,
    realpath,
} from 'fs/promises';
import { getAppTempDirPath } from '@electron/utils/appTempDir';

interface IPathOps {
    dirname(path: string): string;
    isAbsolute(path: string): boolean;
    relative(from: string, to: string): string;
    resolve(path: string): string;
    sep: string;
}

const defaultPathOps: IPathOps = {
    dirname,
    isAbsolute,
    relative,
    resolve,
    sep,
};

const windowsPathOps: IPathOps = {
    dirname: win32.dirname,
    isAbsolute: win32.isAbsolute,
    relative: win32.relative,
    resolve: win32.resolve,
    sep: win32.sep,
};

function stripWindowsExtendedLengthPrefix(filePath: string) {
    if (filePath.startsWith('\\\\?\\UNC\\')) {
        return `\\\\${filePath.slice(8)}`;
    }
    if (filePath.startsWith('\\\\?\\')) {
        return filePath.slice(4);
    }
    return filePath;
}

function isWindowsPathLike(filePath: string) {
    const normalizedPath = stripWindowsExtendedLengthPrefix(filePath);
    return /^[a-zA-Z]:[\\/]/.test(normalizedPath) || normalizedPath.startsWith('\\\\');
}

function getPathOps(...paths: string[]): IPathOps {
    return paths.some(isWindowsPathLike) ? windowsPathOps : defaultPathOps;
}

function normalizePathForComparison(filePath: string, ops: IPathOps) {
    const normalizedPath = ops.resolve(stripWindowsExtendedLengthPrefix(filePath));
    return ops === windowsPathOps ? normalizedPath.toLowerCase() : normalizedPath;
}

function normalizeCandidatePath(filePath: string) {
    if (!filePath || filePath.trim() === '') {
        return null;
    }

    try {
        const trimmedPath = filePath.trim();
        return getPathOps(trimmedPath).resolve(trimmedPath);
    } catch {
        return null;
    }
}

function isPathInsideBaseDir(baseDir: string, candidatePath: string) {
    const ops = getPathOps(baseDir, candidatePath);
    const relativePath = ops.relative(
        normalizePathForComparison(baseDir, ops),
        normalizePathForComparison(candidatePath, ops),
    );

    if (relativePath === '' || relativePath === '.') {
        return false;
    }

    return (
        relativePath !== '..'
        && !relativePath.startsWith(`..${ops.sep}`)
        && !ops.isAbsolute(relativePath)
    );
}

function isPathInsideAnyBaseDir(baseDirs: string[], candidatePath: string) {
    for (const baseDir of baseDirs) {
        if (isPathInsideBaseDir(baseDir, candidatePath)) {
            return true;
        }
    }
    return false;
}

function isSamePath(left: string, right: string) {
    const ops = getPathOps(left, right);
    return normalizePathForComparison(left, ops) === normalizePathForComparison(right, ops);
}

function isPathSameAsAnyBaseDir(baseDirs: string[], candidatePath: string) {
    return baseDirs.some(baseDir => isSamePath(baseDir, candidatePath));
}

function safeRealpathSync(path: string) {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

// The temp namespace is fixed at startup and getAppTempDir() refuses symlinked
// temp roots, so the canonical base dirs cannot legitimately change while the
// configured path stays the same; caching them avoids a realpath per validation.
let cachedTempBaseDirs: {
    configuredTempDir: string;
    baseDirs: string[];
} | null = null;

function getTempBaseDirsSync() {
    const configuredTempDir = getAppTempDirPath();
    if (cachedTempBaseDirs?.configuredTempDir === configuredTempDir) {
        return cachedTempBaseDirs.baseDirs;
    }
    const tempDir = normalizeCandidatePath(configuredTempDir) ?? resolve(configuredTempDir);
    let canonicalTempDir = tempDir;
    let canonicalized = false;
    try {
        canonicalTempDir = realpathSync(tempDir);
        canonicalized = true;
    } catch {
        // The app temp dir is created lazily; before it exists realpath
        // cannot resolve it and the canonical form is unknown.
    }
    const baseDirs = isSamePath(canonicalTempDir, tempDir)
        ? [tempDir]
        : [
            tempDir,
            canonicalTempDir,
        ];
    // Cache only a successful canonicalization. Caching the pre-existence
    // fallback pinned an uncanonicalized base set for the process lifetime,
    // which rejected every temp read on hosts where the configured and
    // canonical forms differ (Windows 8.3 short names, macOS /var symlinks).
    if (canonicalized) {
        cachedTempBaseDirs = {
            configuredTempDir,
            baseDirs,
        };
    }
    return baseDirs;
}

export function resetPathValidatorCachesForTests() {
    cachedTempBaseDirs = null;
}

/**
 * Compact validator-state description for read-rejection errors. Rejections
 * proved undiagnosable from renderer-visible state alone (issue #82), so the
 * error must carry what the validator actually computed and observed.
 */
export function describeReadPathValidationForDiagnostics(filePath: string) {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return 'candidate=unnormalizable';
    }
    let baseDirs: string[];
    try {
        baseDirs = getTempBaseDirsSync();
    } catch (error) {
        return `baseDirs=error:${error instanceof Error ? error.message : String(error)}`;
    }
    let lstatOutcome = 'ok';
    try {
        if (lstatSync(absolutePath).isSymbolicLink()) {
            lstatOutcome = 'symlink';
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
        lstatOutcome = `error:${code}`;
    }
    let realpathOutcome: string;
    try {
        realpathOutcome = realpathSync(absolutePath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
        realpathOutcome = `error:${code}`;
    }
    return `baseDirs=[${baseDirs.join(' | ')}]; lstat=${lstatOutcome}; realpath=${realpathOutcome}`;
}

function isSymlinkPathSync(path: string) {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

function resolveExistingTempPath(absolutePath: string, tempBaseDirs: string[]): string | false | null {
    try {
        if (lstatSync(absolutePath).isSymbolicLink()) {
            return false;
        }

        const resolvedPath = safeRealpathSync(absolutePath);
        return isPathInsideAnyBaseDir(tempBaseDirs, resolvedPath)
            ? resolvedPath
            : false;
    } catch {
        return null;
    }
}

export function isAllowedWritePath(filePath: string) {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return false;
    }

    try {
        const tempBaseDirs = getTempBaseDirsSync();
        if (!isPathInsideAnyBaseDir(tempBaseDirs, absolutePath)) {
            return false;
        }

        return !isSymlinkPathSync(absolutePath);
    } catch {
        return false;
    }
}

export function isAllowedReadPath(filePath: string) {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return false;
    }

    try {
        const tempBaseDirs = getTempBaseDirsSync();
        if (!isPathInsideAnyBaseDir(tempBaseDirs, absolutePath)) {
            return false;
        }

        if (!existsSync(absolutePath)) {
            return false;
        }

        return !isSymlinkPathSync(absolutePath);
    } catch {
        return false;
    }
}

export async function resolveAllowedReadPath(filePath: string) {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return null;
    }

    const tempBaseDirs = getTempBaseDirsSync();
    if (!isPathInsideAnyBaseDir(tempBaseDirs, absolutePath)) {
        return null;
    }

    try {
        if ((await lstat(absolutePath)).isSymbolicLink()) {
            return null;
        }

        const resolvedPath = await realpath(absolutePath).catch(() => absolutePath);
        return isPathInsideAnyBaseDir(tempBaseDirs, resolvedPath) ? resolvedPath : null;
    } catch {
        return null;
    }
}

function resolveAllowedWritePathSync(filePath: string) {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return null;
    }

    const tempBaseDirs = getTempBaseDirsSync();
    if (!isPathInsideAnyBaseDir(tempBaseDirs, absolutePath)) {
        return null;
    }

    const resolvedTargetPath = resolveExistingTempPath(absolutePath, tempBaseDirs);
    if (resolvedTargetPath === false) {
        return null;
    }
    if (resolvedTargetPath === null) {
        // The target may not exist yet. Validate the parent directory path.
    }

    try {
        const ops = getPathOps(absolutePath);
        const parentDir = ops.dirname(absolutePath);
        const resolvedParentDir = safeRealpathSync(parentDir);
        const isTempDirRoot = isPathSameAsAnyBaseDir(tempBaseDirs, resolvedParentDir);
        if (!isPathInsideAnyBaseDir(tempBaseDirs, resolvedParentDir) && !isTempDirRoot) {
            return null;
        }
    } catch {
        return null;
    }

    return absolutePath;
}

export function resolveAllowedWritePath(filePath: string) {
    return Promise.resolve(resolveAllowedWritePathSync(filePath));
}
