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

async function getTempBaseDirs() {
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

export async function resolveAllowedReadPath(filePath: string): Promise<string | null> {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return null;
    }

    const tempBaseDirs = await getTempBaseDirs();
    if (!isPathInsideAnyBaseDir(tempBaseDirs, absolutePath)) {
        return null;
    }

    try {
        if (lstatSync(absolutePath).isSymbolicLink()) {
            return null;
        }
        const resolvedPath = safeRealpathSync(absolutePath);
        if (!isPathInsideAnyBaseDir(tempBaseDirs, resolvedPath)) {
            return null;
        }
        return resolvedPath;
    } catch {
        return null;
    }
}

export async function resolveAllowedWritePath(filePath: string): Promise<string | null> {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return null;
    }

    const tempBaseDirs = await getTempBaseDirs();
    if (!isPathInsideAnyBaseDir(tempBaseDirs, absolutePath)) {
        return null;
    }

    try {
        if (lstatSync(absolutePath).isSymbolicLink()) {
            return null;
        }

        const resolvedTargetPath = safeRealpathSync(absolutePath);
        if (!isPathInsideAnyBaseDir(tempBaseDirs, resolvedTargetPath)) {
            return null;
        }
    } catch {
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
