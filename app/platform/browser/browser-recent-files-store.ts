import type { IRecentFile } from '@contracts/shared';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/local-storage';
import { BROWSER_RECENT_FILES_STORAGE_KEY } from '@app/utils/browser-runtime-persistence';
import {
    parseRecentFilesPayload,
    RECENT_FILES_COOKIE_KEY,
    RECENT_FILES_COOKIE_MAX_AGE_SECONDS,
    serializeRecentFilesCookiePayload,
    serializeRecentFilesPayload,
} from '@app/utils/recent-files-persistence';
import {
    BROWSER_MAX_RECENT_FILES,
    BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES,
    buildRecentFilesFromPersistedRecords,
    type IBrowserPersistedDocumentRecord,
} from './browser-document-types';

export function readRecentFilesFromStorage() {
    const raw = safeGetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY);
    return parseRecentFilesPayload(raw);
}

export function hasRecentFilesStorageSnapshot() {
    return safeGetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY) !== null;
}

function writeRecentFilesToCookie(recentFiles: IRecentFile[]) {
    if (typeof document === 'undefined') {
        return;
    }

    if (recentFiles.length === 0) {
        document.cookie = `${RECENT_FILES_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
        return;
    }

    const encodedValue = encodeURIComponent(serializeRecentFilesCookiePayload(recentFiles));
    document.cookie = `${RECENT_FILES_COOKIE_KEY}=${encodedValue}; Path=/; Max-Age=${RECENT_FILES_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

export function writeRecentFilesToStorage(recentFiles: IRecentFile[]) {
    const payload = serializeRecentFilesPayload(recentFiles);
    safeSetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY, payload);
    writeRecentFilesToCookie(recentFiles);
}

function normalizeRecentFileSize(fileSize: number | undefined) {
    if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize < 0) {
        return 0;
    }

    return Math.floor(fileSize);
}

export function pruneRecentFiles(recentFiles: IRecentFile[]) {
    const keptRecentFiles: IRecentFile[] = [];
    const evictedRefs = new Set<string>();
    const keptRefs = new Set<string>();
    let totalBytes = 0;

    for (const recentFile of recentFiles) {
        if (keptRefs.has(recentFile.originalPath)) {
            evictedRefs.add(recentFile.originalPath);
            continue;
        }

        const fileSize = normalizeRecentFileSize(recentFile.fileSize);
        const exceedsCountLimit = keptRecentFiles.length >= BROWSER_MAX_RECENT_FILES;
        const exceedsByteLimit = keptRecentFiles.length > 0
            && (totalBytes + fileSize) > BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES;

        if (exceedsCountLimit || exceedsByteLimit) {
            evictedRefs.add(recentFile.originalPath);
            continue;
        }

        keptRecentFiles.push({
            ...recentFile,
            fileSize,
        });
        keptRefs.add(recentFile.originalPath);
        totalBytes += fileSize;
    }

    return {
        recentFiles: keptRecentFiles,
        evictedRefs: Array.from(evictedRefs),
    };
}

export interface IBrowserRecentFilesRepository {
    requireEntry: (ref: string) => Promise<{
        retention: 'durable' | 'transient';
        saveName?: string;
        fileName: string;
        fileSize: number;
    }>;
    getAllPersistedRecords: () => Promise<IBrowserPersistedDocumentRecord[]>;
    cleanupEvictedRecentRefs: (refs: string[]) => Promise<void>;
}

export class BrowserRecentFilesStore {
    public constructor(private readonly repository: IBrowserRecentFilesRepository) {}

    public async touchRecentFile(ref: string) {
        const entry = await this.repository.requireEntry(ref);
        if (entry.retention === 'transient') {
            await this.removeRecentFile(ref);
            return;
        }
        const nextRecentFiles = readRecentFilesFromStorage().filter(
            (candidate) => candidate.originalPath !== ref,
        );

        nextRecentFiles.unshift({
            originalPath: ref,
            fileName: entry.saveName ?? entry.fileName,
            timestamp: Date.now(),
            fileSize: entry.fileSize,
        });

        const {
            recentFiles,
            evictedRefs,
        } = pruneRecentFiles(nextRecentFiles);
        writeRecentFilesToStorage(recentFiles);
        await this.repository.cleanupEvictedRecentRefs(evictedRefs);
    }

    public getRecentFiles() {
        const recentFiles = readRecentFilesFromStorage();
        writeRecentFilesToCookie(recentFiles);
        return recentFiles;
    }

    public async recoverRecentFilesIfStorageMissing() {
        if (hasRecentFilesStorageSnapshot()) {
            return readRecentFilesFromStorage();
        }

        const records = await this.repository.getAllPersistedRecords();
        const { recentFiles } = pruneRecentFiles(buildRecentFilesFromPersistedRecords(records));
        writeRecentFilesToStorage(recentFiles);
        return recentFiles;
    }

    public async removeRecentFile(ref: string) {
        const currentRecentFiles = readRecentFilesFromStorage();
        const nextRecentFiles = currentRecentFiles.filter(
            (candidate) => candidate.originalPath !== ref,
        );

        writeRecentFilesToStorage(nextRecentFiles);
        if (nextRecentFiles.length !== currentRecentFiles.length) {
            await this.repository.cleanupEvictedRecentRefs([ref]);
        }
    }

    public async clearRecentFiles() {
        const evictedRefs = readRecentFilesFromStorage().map(
            (candidate) => candidate.originalPath,
        );
        writeRecentFilesToStorage([]);
        await this.repository.cleanupEvictedRecentRefs(evictedRefs);
    }
}
