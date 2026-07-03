import type { IRecentFile } from '@contracts/shared';
import { defaultRetentionForKind } from '@app/platform/browser/browserDocumentStoragePolicy';
import type { IBrowserPersistedDocumentRecord } from '@app/platform/browser/browserDocumentTypes';

export function buildRecentFilesFromPersistedRecords(
    records: IBrowserPersistedDocumentRecord[],
) {
    return records
        .filter((record) => {
            const retention = record.retention ?? defaultRetentionForKind(record.kind);
            return record.kind !== 'working' && retention !== 'transient';
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map<IRecentFile>(record => ({
            originalPath: record.ref,
            backend: 'browser',
            fileName: record.saveName ?? record.fileName,
            timestamp: record.updatedAt,
            fileSize: record.fileSize,
        }));
}
