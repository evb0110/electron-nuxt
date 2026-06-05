import {
    resolve,
    win32,
} from 'path';

interface IWorkingCopyOriginalEntry {
    originalPath: string;
    ownerWebContentsId?: number;
}

export const workingCopyMap = new Map<string, IWorkingCopyOriginalEntry>();

const retiredWorkingCopyOriginalMap = new Map<string, {
    expiresAtMs: number;
    originalPath: string;
    ownerWebContentsId?: number;
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

export function getWorkingCopyOriginalPath(workingPath: string, senderWebContentsId?: number) {
    const activeEntry = workingCopyMap.get(workingPath);
    if (activeEntry) {
        if (!canUseWorkingCopyEntry(activeEntry, senderWebContentsId)) {
            return null;
        }
        return {
            originalPath: activeEntry.originalPath,
            ...(activeEntry.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: activeEntry.ownerWebContentsId}),
            retired: false,
        };
    }

    pruneRetiredWorkingCopyOriginals();
    const retired = retiredWorkingCopyOriginalMap.get(workingPath);
    if (!retired) {
        return null;
    }
    if (!canUseWorkingCopyEntry(retired, senderWebContentsId)) {
        return null;
    }

    return {
        originalPath: retired.originalPath,
        ...(retired.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: retired.ownerWebContentsId}),
        retired: true,
    };
}

export function setWorkingCopyOriginalPath(workingPath: string, originalPath: string, ownerWebContentsId?: number) {
    workingCopyMap.set(workingPath, {
        originalPath,
        ...(typeof ownerWebContentsId === 'number' ? {ownerWebContentsId} : {}),
    });
}

export function rememberRetiredWorkingCopyOriginal(
    workingPath: string,
    originalPath: string | undefined,
    ownerWebContentsId?: number,
) {
    if (!originalPath) {
        return;
    }
    retiredWorkingCopyOriginalMap.set(workingPath, {
        originalPath,
        ...(typeof ownerWebContentsId === 'number' ? {ownerWebContentsId} : {}),
        expiresAtMs: Date.now() + RETIRED_WORKING_COPY_TTL_MS,
    });
}

export function clearRetiredWorkingCopyOriginals() {
    retiredWorkingCopyOriginalMap.clear();
}

export function forgetRetiredWorkingCopyOriginal(workingPath: string) {
    retiredWorkingCopyOriginalMap.delete(workingPath);
}

function canUseWorkingCopyEntry(entry: IWorkingCopyOriginalEntry, senderWebContentsId?: number) {
    return entry.ownerWebContentsId === undefined || entry.ownerWebContentsId === senderWebContentsId;
}

export function findWorkingCopyPathByOriginalPath(originalPath: string, senderWebContentsId?: number) {
    const normalizedOriginalPath = typeof originalPath === 'string' ? originalPath.trim() : '';
    if (!normalizedOriginalPath) {
        return null;
    }

    const lookupOriginalPath = normalizePathForLookup(normalizedOriginalPath);
    let latestMatch: string | null = null;
    for (const [
        workingPath,
        entry,
    ] of workingCopyMap.entries()) {
        if (
            canUseWorkingCopyEntry(entry, senderWebContentsId)
            && normalizePathForLookup(entry.originalPath) === lookupOriginalPath
        ) {
            latestMatch = workingPath;
        }
    }

    return latestMatch;
}

export function isKnownWorkingCopyOriginalPath(originalPath: string, senderWebContentsId?: number) {
    const normalizedOriginalPath = typeof originalPath === 'string' ? originalPath.trim() : '';
    if (!normalizedOriginalPath) {
        return false;
    }
    const lookupOriginalPath = normalizePathForLookup(normalizedOriginalPath);
    return Array.from(workingCopyMap.values())
        .some(entry => (
            canUseWorkingCopyEntry(entry, senderWebContentsId)
            && normalizePathForLookup(entry.originalPath) === lookupOriginalPath
        ));
}

export function getWorkingCopyOwnerWebContentsId(workingPath: string): number | undefined {
    return workingCopyMap.get(workingPath)?.ownerWebContentsId;
}
