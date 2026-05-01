import { app } from 'electron';
import {
    dirname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from 'path';
import {
    existsSync,
    lstatSync,
    realpathSync,
} from 'fs';

function normalizeCandidatePath(filePath: string) {
    if (!filePath || filePath.trim() === '') {
        return null;
    }

    try {
        return resolve(filePath.trim());
    } catch {
        return null;
    }
}

function isPathInsideBaseDir(baseDir: string, candidatePath: string) {
    const relativePath = relative(baseDir, candidatePath);

    if (relativePath === '' || relativePath === '.') {
        return false;
    }

    return (
        relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
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
    const tempDir = resolve(app.getPath('temp'));
    const canonicalTempDir = safeRealpathSync(tempDir);
    return canonicalTempDir === tempDir
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
        const parentDir = dirname(absolutePath);
        const resolvedParentDir = safeRealpathSync(parentDir);
        const isTempDirRoot = tempBaseDirs.includes(resolvedParentDir);
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
