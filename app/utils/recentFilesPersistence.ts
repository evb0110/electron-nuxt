import type { IRecentFile } from '@contracts/shared';
import { take } from 'es-toolkit/array';
import {
    getOptionalNumber,
    getOptionalString,
    isRecord,
} from '@app/services/pdfjs/runtime';
import { safeGetLocalStorageItem } from '@app/utils/localStorage';
import { BROWSER_RECENT_FILES_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';

export const RECENT_FILES_COOKIE_KEY = 'evb_viewer_recent_files';
export const RECENT_FILES_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
export const RECENT_FILES_LIMIT = 30;
export const RECENT_FILES_COOKIE_MAX_ENCODED_LENGTH = 3000;

interface IRecentFilesCookieSnapshot {
    recentFiles: IRecentFile[];
    hasSnapshot: boolean;
    truncated: boolean;
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
    if (
        typeof originalPath !== 'string'
        || typeof fileName !== 'string'
        || typeof timestamp !== 'number'
    ) {
        return null;
    }

    return {
        originalPath,
        fileName,
        timestamp,
        fileSize: typeof fileSize === 'number' ? fileSize : undefined,
    };
}

function normalizeRecentFilesCollection(value: unknown) {
    if (!Array.isArray(value)) {
        return [];
    }

    const recentFiles: IRecentFile[] = [];
    const seenPaths = new Set<string>();

    for (const candidateValue of value) {
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

function buildRecentFilesCookiePayload(recentFiles: IRecentFile[], truncated: boolean) {
    return {
        v: 1,
        t: truncated,
        f: recentFiles.map(file => [
            file.originalPath,
            file.fileName,
            file.timestamp,
            file.fileSize ?? null,
        ]),
    };
}

export function normalizeRecentFile(value: unknown): IRecentFile | null {
    if (!isRecord(value)) {
        return null;
    }

    const originalPath = getOptionalString(value, 'originalPath');
    const fileName = getOptionalString(value, 'fileName');
    const timestamp = getOptionalNumber(value, 'timestamp');
    if (!originalPath || !fileName || timestamp === null) {
        return null;
    }

    const fileSize = getOptionalNumber(value, 'fileSize') ?? undefined;
    return {
        originalPath,
        fileName,
        timestamp,
        fileSize,
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

export function readBrowserRecentFilesSnapshot(): IRecentFilesCookieSnapshot {
    const cookieSnapshot = parseRecentFilesCookieSnapshot(readCookieValue(RECENT_FILES_COOKIE_KEY));
    if (cookieSnapshot.hasSnapshot && !cookieSnapshot.truncated) {
        return cookieSnapshot;
    }

    const rawStorageSnapshot = safeGetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY);
    if (rawStorageSnapshot !== null) {
        return {
            recentFiles: parseRecentFilesPayload(rawStorageSnapshot),
            hasSnapshot: true,
            truncated: false,
        };
    }

    return cookieSnapshot;
}

export function serializeRecentFilesPayload(recentFiles: IRecentFile[]) {
    return JSON.stringify(take(recentFiles, RECENT_FILES_LIMIT));
}

export function trimRecentFilesForCookie(recentFiles: IRecentFile[]) {
    const trimmed: IRecentFile[] = [];
    let truncated = false;

    for (const candidateValue of recentFiles) {
        const candidate = normalizeRecentFile(candidateValue);
        if (!candidate) {
            continue;
        }

        const nextTrimmed = [
            ...trimmed,
            candidate,
        ];
        const encodedPayload = encodeURIComponent(JSON.stringify(buildRecentFilesCookiePayload(nextTrimmed, false)));
        if (encodedPayload.length > RECENT_FILES_COOKIE_MAX_ENCODED_LENGTH) {
            truncated = true;
            break;
        }

        trimmed.push(candidate);
    }

    return {
        recentFiles: trimmed,
        truncated,
    };
}

export function serializeRecentFilesCookiePayload(recentFiles: IRecentFile[]) {
    const {
        recentFiles: trimmed,
        truncated,
    } = trimRecentFilesForCookie(recentFiles);

    return JSON.stringify(buildRecentFilesCookiePayload(trimmed, truncated));
}
