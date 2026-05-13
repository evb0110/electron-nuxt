import {
    resolve,
    win32,
} from 'path';

export const workingCopyMap = new Map<string, string>();

const retiredWorkingCopyOriginalMap = new Map<string, {
    expiresAtMs: number;
    originalPath: string;
}>();
const RETIRED_WORKING_COPY_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RETIRED_WORKING_COPY_TTL_MS ?? `${10 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        return 10 * 60 * 1000;
    }
    return Math.min(parsed, 60 * 60 * 1000);
})();

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

function normalizePathForLookup(filePath: string) {
    const trimmedPath = filePath.trim();
    if (!trimmedPath) {
        return '';
    }

    if (isWindowsPathLike(trimmedPath)) {
        return win32.resolve(stripWindowsExtendedLengthPrefix(trimmedPath)).toLowerCase();
    }

    return resolve(trimmedPath);
}

function pruneRetiredWorkingCopyOriginals() {
    const now = Date.now();
    for (const [
        workingPath,
        entry,
    ] of retiredWorkingCopyOriginalMap.entries()) {
        if (entry.expiresAtMs <= now) {
            retiredWorkingCopyOriginalMap.delete(workingPath);
        }
    }
}

export function getWorkingCopyOriginalPath(workingPath: string) {
    const activeOriginalPath = workingCopyMap.get(workingPath);
    if (activeOriginalPath) {
        return {
            originalPath: activeOriginalPath,
            retired: false,
        };
    }

    pruneRetiredWorkingCopyOriginals();
    const retired = retiredWorkingCopyOriginalMap.get(workingPath);
    if (!retired) {
        return null;
    }

    return {
        originalPath: retired.originalPath,
        retired: true,
    };
}

export function setWorkingCopyOriginalPath(workingPath: string, originalPath: string) {
    workingCopyMap.set(workingPath, originalPath);
}

export function rememberRetiredWorkingCopyOriginal(workingPath: string, originalPath: string | undefined) {
    if (!originalPath) {
        return;
    }
    retiredWorkingCopyOriginalMap.set(workingPath, {
        originalPath,
        expiresAtMs: Date.now() + RETIRED_WORKING_COPY_TTL_MS,
    });
}

export function clearRetiredWorkingCopyOriginals() {
    retiredWorkingCopyOriginalMap.clear();
}

export function forgetRetiredWorkingCopyOriginal(workingPath: string) {
    retiredWorkingCopyOriginalMap.delete(workingPath);
}

export function findWorkingCopyPathByOriginalPath(originalPath: string): string | null {
    const normalizedOriginalPath = typeof originalPath === 'string' ? originalPath.trim() : '';
    if (!normalizedOriginalPath) {
        return null;
    }

    const lookupOriginalPath = normalizePathForLookup(normalizedOriginalPath);
    let latestMatch: string | null = null;
    for (const [
        workingPath,
        mappedOriginalPath,
    ] of workingCopyMap.entries()) {
        if (normalizePathForLookup(mappedOriginalPath) === lookupOriginalPath) {
            latestMatch = workingPath;
        }
    }

    return latestMatch;
}

export function isKnownWorkingCopyOriginalPath(originalPath: string) {
    const normalizedOriginalPath = typeof originalPath === 'string' ? originalPath.trim() : '';
    if (!normalizedOriginalPath) {
        return false;
    }
    const lookupOriginalPath = normalizePathForLookup(normalizedOriginalPath);
    return Array.from(workingCopyMap.values())
        .some(mappedOriginalPath => normalizePathForLookup(mappedOriginalPath) === lookupOriginalPath);
}
