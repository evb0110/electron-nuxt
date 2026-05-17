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

function safeRealpathSync(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

function getTempBaseDirs() {
    return getTempBaseDirsSync();
}

function getTempBaseDirsSync() {
    const configuredTempDir = getAppTempDirPath();
    const tempDir = normalizeCandidatePath(configuredTempDir) ?? resolve(configuredTempDir);
    const canonicalTempDir = safeRealpathSync(tempDir);
    return isSamePath(canonicalTempDir, tempDir)
        ? [tempDir]
        : [
            tempDir,
            canonicalTempDir,
        ];
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

export function isAllowedWritePath(filePath: string): boolean {
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

export function isAllowedReadPath(filePath: string): boolean {
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

function resolveAllowedReadPathSync(filePath: string): string | null {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return null;
    }

    const tempBaseDirs = getTempBaseDirs();
    if (!isPathInsideAnyBaseDir(tempBaseDirs, absolutePath)) {
        return null;
    }

    const resolvedPath = resolveExistingTempPath(absolutePath, tempBaseDirs);
    return resolvedPath || null;
}

export function resolveAllowedReadPath(filePath: string): Promise<string | null> {
    return Promise.resolve(resolveAllowedReadPathSync(filePath));
}

function resolveAllowedWritePathSync(filePath: string): string | null {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return null;
    }

    const tempBaseDirs = getTempBaseDirs();
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

export function resolveAllowedWritePath(filePath: string): Promise<string | null> {
    return Promise.resolve(resolveAllowedWritePathSync(filePath));
}
