import {
    resolve,
    win32,
} from 'path';
import {
    realpathSync,
    statSync,
} from 'fs';
import { createOriginalFileContentFingerprintSync } from '@electron/file-access/workingCopyOriginalFileExpectation';

export type TWorkingCopyRole = 'current' | 'snapshot';

export interface IWorkingCopyOriginalFileExpectation {
    contentFingerprint?: string;
    mtimeMs: number;
    size: number;
}

interface IWorkingCopyOriginalEntry {
    originalPath: string;
    ownerWebContentsId?: number;
    originalFileExpectation?: IWorkingCopyOriginalFileExpectation;
    registeredAtMs: number;
    registrationId: number;
    role: TWorkingCopyRole;
}

interface ISetWorkingCopyOriginalPathOptions {role?: TWorkingCopyRole;}

interface IRememberRetiredWorkingCopyOriginalOptions {
    originalFileExpectation?: IWorkingCopyOriginalFileExpectation;
    role?: TWorkingCopyRole;
}

export const workingCopyMap = new Map<string, IWorkingCopyOriginalEntry>();

const retiredWorkingCopyOriginalMap = new Map<string, {
    expiresAtMs: number;
    originalPath: string;
    originalFileExpectation?: IWorkingCopyOriginalFileExpectation;
    ownerWebContentsId?: number;
    role: TWorkingCopyRole;
}>();
const currentWorkingCopyByOriginalPath = new Map<string, {
    ownerWebContentsId?: number;
    registeredAtMs: number;
    registrationId: number;
    workingPath: string;
}>();
let nextWorkingCopyRegistrationId = 0;
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

export function normalizePathForLookup(filePath: string) {
    const trimmedPath = filePath.trim();
    if (!trimmedPath) {
        return '';
    }

    if (isWindowsPathLike(trimmedPath)) {
        return win32.resolve(stripWindowsExtendedLengthPrefix(trimmedPath)).toLowerCase();
    }

    try {
        return realpathSync.native(trimmedPath);
    } catch {
        return resolve(trimmedPath);
    }
}

function createOriginalFileExpectation(originalPath: string): IWorkingCopyOriginalFileExpectation | undefined {
    try {
        const originalStat = statSync(originalPath);
        if (!originalStat.isFile()) {
            return undefined;
        }
        let contentFingerprint: string | undefined;
        try {
            contentFingerprint = createOriginalFileContentFingerprintSync(originalPath, originalStat.size);
        } catch {
            contentFingerprint = undefined;
        }
        return {
            ...(contentFingerprint ? {contentFingerprint} : {}),
            mtimeMs: originalStat.mtimeMs,
            size: originalStat.size,
        };
    } catch {
        return undefined;
    }
}

function copyOriginalFileExpectation(
    expectation: IWorkingCopyOriginalFileExpectation | undefined,
): IWorkingCopyOriginalFileExpectation | undefined {
    if (!expectation) {
        return undefined;
    }
    return {
        ...(expectation.contentFingerprint ? {contentFingerprint: expectation.contentFingerprint} : {}),
        mtimeMs: expectation.mtimeMs,
        size: expectation.size,
    };
}

function isSameOwner(left: number | undefined, right: number | undefined) {
    return left === right;
}

function makeCurrentRegistryKey(originalPath: string, ownerWebContentsId?: number) {
    const lookupOriginalPath = normalizePathForLookup(originalPath);
    if (!lookupOriginalPath) {
        return '';
    }
    return `${ownerWebContentsId ?? 'global'}\0${lookupOriginalPath}`;
}

function isNewerWorkingCopyEntry(left: IWorkingCopyOriginalEntry, right: IWorkingCopyOriginalEntry) {
    return (
        left.registeredAtMs > right.registeredAtMs
        || (
            left.registeredAtMs === right.registeredAtMs
            && left.registrationId > right.registrationId
        )
    );
}

function refreshCurrentWorkingCopyForOriginal(originalPath: string, ownerWebContentsId?: number) {
    const registryKey = makeCurrentRegistryKey(originalPath, ownerWebContentsId);
    if (!registryKey) {
        return;
    }
    const lookupOriginalPath = normalizePathForLookup(originalPath);
    let latestMatch: {
        entry: IWorkingCopyOriginalEntry;
        workingPath: string;
    } | null = null;
    for (const [
        workingPath,
        entry,
    ] of workingCopyMap.entries()) {
        if (
            entry.role === 'current'
            && isSameOwner(entry.ownerWebContentsId, ownerWebContentsId)
            && normalizePathForLookup(entry.originalPath) === lookupOriginalPath
            && (!latestMatch || isNewerWorkingCopyEntry(entry, latestMatch.entry))
        ) {
            latestMatch = {
                entry,
                workingPath,
            };
        }
    }

    if (!latestMatch) {
        currentWorkingCopyByOriginalPath.delete(registryKey);
        return;
    }

    currentWorkingCopyByOriginalPath.set(registryKey, {
        ...(latestMatch.entry.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: latestMatch.entry.ownerWebContentsId}),
        registeredAtMs: latestMatch.entry.registeredAtMs,
        registrationId: latestMatch.entry.registrationId,
        workingPath: latestMatch.workingPath,
    });
}

function setCurrentWorkingCopyForOriginal(workingPath: string, entry: IWorkingCopyOriginalEntry) {
    if (entry.role !== 'current') {
        return;
    }
    const registryKey = makeCurrentRegistryKey(entry.originalPath, entry.ownerWebContentsId);
    if (!registryKey) {
        return;
    }
    currentWorkingCopyByOriginalPath.set(registryKey, {
        ...(entry.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: entry.ownerWebContentsId}),
        registeredAtMs: entry.registeredAtMs,
        registrationId: entry.registrationId,
        workingPath,
    });
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

export function setWorkingCopyOriginalPath(
    workingPath: string,
    originalPath: string,
    ownerWebContentsId?: number,
    options: ISetWorkingCopyOriginalPathOptions = {},
) {
    const existingEntry = workingCopyMap.get(workingPath);
    if (existingEntry) {
        workingCopyMap.delete(workingPath);
        refreshCurrentWorkingCopyForOriginal(existingEntry.originalPath, existingEntry.ownerWebContentsId);
    }

    const role = options.role ?? 'current';
    const originalFileExpectation = createOriginalFileExpectation(originalPath);
    const entry: IWorkingCopyOriginalEntry = {
        originalPath,
        ...(typeof ownerWebContentsId === 'number' ? {ownerWebContentsId} : {}),
        ...(originalFileExpectation ? {originalFileExpectation} : {}),
        registeredAtMs: Date.now(),
        registrationId: nextWorkingCopyRegistrationId += 1,
        role,
    };
    workingCopyMap.set(workingPath, entry);
    retiredWorkingCopyOriginalMap.delete(workingPath);
    setCurrentWorkingCopyForOriginal(workingPath, entry);
}

export function rememberRetiredWorkingCopyOriginal(
    workingPath: string,
    originalPath: string | undefined,
    ownerWebContentsId?: number,
    options: IRememberRetiredWorkingCopyOriginalOptions = {},
) {
    if (!originalPath) {
        return;
    }
    const originalFileExpectation = copyOriginalFileExpectation(options.originalFileExpectation);
    retiredWorkingCopyOriginalMap.set(workingPath, {
        originalPath,
        ...(originalFileExpectation ? {originalFileExpectation} : {}),
        ...(typeof ownerWebContentsId === 'number' ? {ownerWebContentsId} : {}),
        expiresAtMs: Date.now() + RETIRED_WORKING_COPY_TTL_MS,
        role: options.role ?? 'current',
    });
}

export function clearRetiredWorkingCopyOriginals() {
    retiredWorkingCopyOriginalMap.clear();
}

export function forgetRetiredWorkingCopyOriginal(workingPath: string) {
    retiredWorkingCopyOriginalMap.delete(workingPath);
}

export function forgetWorkingCopyOriginalPath(workingPath: string) {
    const existingEntry = workingCopyMap.get(workingPath);
    if (!existingEntry) {
        return false;
    }

    workingCopyMap.delete(workingPath);
    refreshCurrentWorkingCopyForOriginal(existingEntry.originalPath, existingEntry.ownerWebContentsId);
    return true;
}

export function clearWorkingCopyOriginalPaths() {
    workingCopyMap.clear();
    currentWorkingCopyByOriginalPath.clear();
    nextWorkingCopyRegistrationId = 0;
}

function canUseWorkingCopyEntry(entry: {ownerWebContentsId?: number}, senderWebContentsId?: number) {
    return entry.ownerWebContentsId === undefined || entry.ownerWebContentsId === senderWebContentsId;
}

function getCurrentWorkingCopyForRegistryKey(registryKey: string, senderWebContentsId?: number) {
    const currentEntry = currentWorkingCopyByOriginalPath.get(registryKey);
    if (!currentEntry) {
        return null;
    }

    const activeEntry = workingCopyMap.get(currentEntry.workingPath);
    if (
        !activeEntry
        || activeEntry.role !== 'current'
        || !canUseWorkingCopyEntry(activeEntry, senderWebContentsId)
        || makeCurrentRegistryKey(activeEntry.originalPath, activeEntry.ownerWebContentsId) !== registryKey
    ) {
        currentWorkingCopyByOriginalPath.delete(registryKey);
        if (activeEntry) {
            refreshCurrentWorkingCopyForOriginal(activeEntry.originalPath, activeEntry.ownerWebContentsId);
        }
        return null;
    }

    return currentEntry.workingPath;
}

export function findWorkingCopyPathByOriginalPath(originalPath: string, senderWebContentsId?: number) {
    const normalizedOriginalPath = typeof originalPath === 'string' ? originalPath.trim() : '';
    if (!normalizedOriginalPath) {
        return null;
    }

    if (typeof senderWebContentsId === 'number') {
        const senderScopedPath = getCurrentWorkingCopyForRegistryKey(
            makeCurrentRegistryKey(normalizedOriginalPath, senderWebContentsId),
            senderWebContentsId,
        );
        if (senderScopedPath) {
            return senderScopedPath;
        }
    }

    return getCurrentWorkingCopyForRegistryKey(
        makeCurrentRegistryKey(normalizedOriginalPath),
        senderWebContentsId,
    );
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

export function getWorkingCopyRole(workingPath: string, senderWebContentsId?: number): TWorkingCopyRole | null {
    const activeEntry = workingCopyMap.get(workingPath);
    if (activeEntry) {
        return canUseWorkingCopyEntry(activeEntry, senderWebContentsId) ? activeEntry.role : null;
    }

    pruneRetiredWorkingCopyOriginals();
    const retiredEntry = retiredWorkingCopyOriginalMap.get(workingPath);
    if (!retiredEntry || !canUseWorkingCopyEntry(retiredEntry, senderWebContentsId)) {
        return null;
    }

    return retiredEntry.role;
}

export function getWorkingCopyOriginalFileExpectation(
    workingPath: string,
    senderWebContentsId?: number,
): IWorkingCopyOriginalFileExpectation | null {
    const activeEntry = workingCopyMap.get(workingPath);
    if (!activeEntry || !canUseWorkingCopyEntry(activeEntry, senderWebContentsId)) {
        return null;
    }

    return copyOriginalFileExpectation(activeEntry.originalFileExpectation) ?? null;
}

export function refreshWorkingCopyOriginalFileExpectation(
    workingPath: string,
    senderWebContentsId?: number,
) {
    const activeEntry = workingCopyMap.get(workingPath);
    if (!activeEntry || !canUseWorkingCopyEntry(activeEntry, senderWebContentsId)) {
        return false;
    }

    const expectation = createOriginalFileExpectation(activeEntry.originalPath);
    if (expectation) {
        activeEntry.originalFileExpectation = expectation;
    } else {
        delete activeEntry.originalFileExpectation;
    }
    return true;
}
