import type { IRecentFile } from '@contracts/shared';
import {
    getOptionalNumber,
    getOptionalString,
    isRecord,
} from '@app/services/pdfjs/runtime';

export const RECENT_FILES_COOKIE_KEY = 'evb_viewer_recent_files';
export const RECENT_FILES_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
export const RECENT_FILES_LIMIT = 30;
export const RECENT_FILES_COOKIE_SSR_LIMIT = 8;
export const RECENT_FILES_COOKIE_MAX_ENCODED_LENGTH = 3000;

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
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .map(normalizeRecentFile)
            .filter((entry): entry is IRecentFile => entry !== null)
            .slice(0, RECENT_FILES_LIMIT);
    } catch {
        return [];
    }
}

export function serializeRecentFilesPayload(recentFiles: IRecentFile[]) {
    return JSON.stringify(recentFiles.slice(0, RECENT_FILES_LIMIT));
}

export function trimRecentFilesForCookie(recentFiles: IRecentFile[]) {
    const trimmed: IRecentFile[] = [];

    for (const candidateValue of recentFiles) {
        const candidate = normalizeRecentFile(candidateValue);
        if (!candidate) {
            continue;
        }

        const nextTrimmed = [
            ...trimmed,
            candidate,
        ];
        const encodedPayload = encodeURIComponent(JSON.stringify(nextTrimmed));
        if (encodedPayload.length > RECENT_FILES_COOKIE_MAX_ENCODED_LENGTH) {
            break;
        }

        trimmed.push(candidate);
        if (trimmed.length >= RECENT_FILES_COOKIE_SSR_LIMIT) {
            break;
        }
    }

    return trimmed;
}

export function serializeRecentFilesCookiePayload(recentFiles: IRecentFile[]) {
    return JSON.stringify(trimRecentFilesForCookie(recentFiles));
}
