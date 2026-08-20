import type { IRecentFile } from '@contracts/shared';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import { BROWSER_RECENT_FILES_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';
import {
    expireLegacyRecentFilesCookie,
    parseRecentFilesPayload,
    parseRecentFilesStorageSnapshot,
    serializeRecentFilesPayload,
} from '@app/utils/recentFilesPersistence';
import {
    BROWSER_MAX_RECENT_FILES,
    BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES,
} from '@app/platform/browser/browserDocumentConstants';
import { buildRecentFilesFromPersistedRecords } from '@app/platform/browser/buildRecentFilesFromPersistedRecords';
import type { IBrowserPersistedDocumentRecordsLoadResult } from '@app/platform/browser/browserPersistedDocumentRecordsLoadResult';

export function readRecentFilesFromStorage() {
    const raw = safeGetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY);
    return parseRecentFilesPayload(raw);
}

export function hasRecentFilesStorageSnapshot() {
    const raw = safeGetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY);
    if (raw === null) {
        return false;
    }
    const snapshot = parseRecentFilesStorageSnapshot(raw);
    return snapshot.hasSnapshot && !snapshot.truncated;
}

export function writeRecentFilesToStorage(recentFiles: IRecentFile[]) {
    const payload = serializeRecentFilesPayload(recentFiles);
    safeSetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY, payload);
    expireLegacyRecentFilesCookie();
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
            backend: 'browser',
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
        updatedAt: number;
    }>;
    getAllPersistedRecords: () => Promise<IBrowserPersistedDocumentRecordsLoadResult>;
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
            backend: 'browser',
            fileName: entry.saveName ?? entry.fileName,
            timestamp: Date.now(),
            fileSize: entry.fileSize,
            modifiedAt: entry.updatedAt,
        });

        const {
            recentFiles,
            evictedRefs,
        } = pruneRecentFiles(nextRecentFiles);
        writeRecentFilesToStorage(recentFiles);
        await this.repository.cleanupEvictedRecentRefs(evictedRefs);
    }

    public getRecentFiles() {
        expireLegacyRecentFilesCookie();
        return readRecentFilesFromStorage();
    }

    public async recoverRecentFilesIfStorageMissing() {
        if (hasRecentFilesStorageSnapshot()) {
            return this.getRecentFiles();
        }

        const {
            available,
            records,
        } = await this.repository.getAllPersistedRecords();
        if (!available) {
            return [];
        }
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
