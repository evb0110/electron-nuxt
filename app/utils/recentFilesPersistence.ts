import type { IRecentFile } from '@contracts/shared';
import { take } from 'es-toolkit/array';
import {
    inferDocumentRefBackend,
    type TDocumentBackend,
} from '@contracts/documentRef';
import {
    getOptionalNumber,
    getOptionalString,
    isRecord,
} from '@app/services/pdfjs/runtime';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import { BROWSER_RECENT_FILES_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';

export const RECENT_FILES_COOKIE_KEY = 'evb_viewer_recent_files';
const RECENT_FILES_LIMIT = 30;

interface IRecentFilesCookieSnapshot {
    recentFiles: IRecentFile[];
    hasSnapshot: boolean;
    truncated: boolean;
}

function normalizeRecentFileBackend(value: unknown, originalPath: unknown): TDocumentBackend | null {
    if (value === 'browser' || value === 'electron') {
        return value;
    }
    if (typeof originalPath !== 'string') {
        return null;
    }

    const inferred = inferDocumentRefBackend(originalPath);
    return inferred === 'unknown' ? null : inferred;
}

function normalizeRecentFileTuple(value: unknown): IRecentFile | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const tuple = value as unknown[];
    const originalPath = tuple[0];
    const fileName = tuple[1];
    const timestamp = tuple[2];
    const fileSize = tuple[3];
    const backend = normalizeRecentFileBackend(tuple[4], originalPath);
    const modifiedAt = tuple[5];
    if (
        typeof originalPath !== 'string'
        || typeof fileName !== 'string'
        || typeof timestamp !== 'number'
        || backend === null
    ) {
        return null;
    }

    return {
        originalPath,
        backend,
        fileName,
        timestamp,
        ...(typeof fileSize === 'number' ? {fileSize} : {}),
        ...(typeof modifiedAt === 'number' ? {modifiedAt} : {}),
    };
}

function normalizeRecentFilesCollection(value: unknown) {
    if (!Array.isArray(value)) {
        return [];
    }

    const recentFiles: IRecentFile[] = [];
    const seenPaths = new Set<string>();
    const values: unknown[] = value;

    for (const candidateValue of values) {
        const candidate = normalizeRecentFile(candidateValue) ?? normalizeRecentFileTuple(candidateValue);
        if (!candidate || seenPaths.has(candidate.originalPath)) {
            continue;
        }

        seenPaths.add(candidate.originalPath);
        recentFiles.push(candidate);
        if (recentFiles.length >= RECENT_FILES_LIMIT) {
            break;
        }
    }

    return recentFiles;
}

function isValidRecentFilesCollection(value: unknown) {
    return Array.isArray(value) && value.every(
        candidate => normalizeRecentFile(candidate) !== null
            || normalizeRecentFileTuple(candidate) !== null,
    );
}

function parseJsonValue(raw: string | null | undefined): unknown {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function parseStrictRecentFilesSnapshot(
    collection: unknown,
    truncated: boolean,
): IRecentFilesCookieSnapshot {
    if (!isValidRecentFilesCollection(collection)) {
        return {
            recentFiles: [],
            hasSnapshot: false,
            truncated: false,
        };
    }
    return {
        recentFiles: normalizeRecentFilesCollection(collection),
        hasSnapshot: true,
        truncated,
    };
}

export function parseLegacyRecentFilesCookieSnapshot(raw: string | null | undefined) {
    const parsed = parseJsonValue(raw);
    if (!isRecord(parsed)
        || parsed.v !== 1
        || typeof parsed.t !== 'boolean'
        || !Array.isArray(parsed.f)) {
        return parseStrictRecentFilesSnapshot(null, false);
    }
    return parseStrictRecentFilesSnapshot(parsed.f, parsed.t);
}

export function parseRecentFilesStorageSnapshot(raw: string | null | undefined) {
    const parsed = parseJsonValue(raw);
    if (Array.isArray(parsed)) {
        return parseStrictRecentFilesSnapshot(parsed, false);
    }
    if (isRecord(parsed)
        && parsed.truncated === true
        && Array.isArray(parsed.files)) {
        return parseStrictRecentFilesSnapshot(parsed.files, true);
    }
    return parseStrictRecentFilesSnapshot(null, false);
}

function normalizeRecentFile(value: unknown): IRecentFile | null {
    if (!isRecord(value)) {
        return null;
    }

    const originalPath = getOptionalString(value, 'originalPath');
    const fileName = getOptionalString(value, 'fileName');
    const timestamp = getOptionalNumber(value, 'timestamp');
    const backend = normalizeRecentFileBackend(value.backend, originalPath);
    if (!originalPath || !fileName || timestamp === null || backend === null) {
        return null;
    }

    const fileSize = getOptionalNumber(value, 'fileSize');
    const modifiedAt = getOptionalNumber(value, 'modifiedAt');
    return {
        originalPath,
        backend,
        fileName,
        timestamp,
        ...(fileSize === null ? {} : {fileSize}),
        ...(modifiedAt === null ? {} : {modifiedAt}),
    };
}

export function parseRecentFilesPayload(raw: string | null | undefined) {
    if (!raw) {
        return [];
    }

    try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return normalizeRecentFilesCollection(parsed);
        }

        if (!isRecord(parsed)) {
            return [];
        }

        return normalizeRecentFilesCollection(
            Array.isArray(parsed.f)
                ? parsed.f
                : parsed.files,
        );
    } catch {
        return [];
    }
}

export function parseRecentFilesCookieSnapshot(raw: string | null | undefined): IRecentFilesCookieSnapshot {
    if (!raw) {
        return {
            recentFiles: [],
            hasSnapshot: false,
            truncated: false,
        };
    }

    try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return {
                recentFiles: normalizeRecentFilesCollection(parsed),
                hasSnapshot: true,
                truncated: false,
            };
        }

        if (!isRecord(parsed)) {
            return {
                recentFiles: [],
                hasSnapshot: false,
                truncated: false,
            };
        }

        return {
            recentFiles: normalizeRecentFilesCollection(
                Array.isArray(parsed.f)
                    ? parsed.f
                    : parsed.files,
            ),
            hasSnapshot: true,
            truncated: parsed.t === true || parsed.truncated === true,
        };
    } catch {
        return {
            recentFiles: [],
            hasSnapshot: false,
            truncated: false,
        };
    }
}

function readCookieValue(key: string) {
    if (typeof document === 'undefined' || typeof document.cookie !== 'string') {
        return null;
    }

    const prefix = `${key}=`;
    const cookie = document.cookie
        .split(';')
        .map(part => part.trim())
        .find(part => part.startsWith(prefix));
    if (!cookie) {
        return null;
    }

    try {
        return decodeURIComponent(cookie.slice(prefix.length));
    } catch {
        return cookie.slice(prefix.length);
    }
}

export function expireLegacyRecentFilesCookie() {
    if (typeof document === 'undefined') {
        return;
    }
    const secureAttribute = typeof location !== 'undefined' && location.protocol === 'https:'
        ? '; Secure'
        : '';
    document.cookie = `${RECENT_FILES_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secureAttribute}`;
}

export function readBrowserRecentFilesSnapshot(): IRecentFilesCookieSnapshot {
    const legacySnapshot = parseLegacyRecentFilesCookieSnapshot(
        readCookieValue(RECENT_FILES_COOKIE_KEY),
    );
    if (legacySnapshot.hasSnapshot) {
        safeSetLocalStorageItem(
            BROWSER_RECENT_FILES_STORAGE_KEY,
            legacySnapshot.truncated
                ? JSON.stringify({
                    files: legacySnapshot.recentFiles,
                    truncated: true,
                })
                : serializeRecentFilesPayload(legacySnapshot.recentFiles),
        );
        expireLegacyRecentFilesCookie();
        return legacySnapshot;
    }
    expireLegacyRecentFilesCookie();

    const rawStorageSnapshot = safeGetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY);
    if (rawStorageSnapshot !== null) {
        const storageSnapshot = parseRecentFilesStorageSnapshot(rawStorageSnapshot);
        if (storageSnapshot.hasSnapshot) {
            return storageSnapshot;
        }
    }
    return {
        recentFiles: [],
        hasSnapshot: false,
        truncated: false,
    };
}

export function serializeRecentFilesPayload(recentFiles: IRecentFile[]) {
    return JSON.stringify(take(recentFiles, RECENT_FILES_LIMIT));
}
