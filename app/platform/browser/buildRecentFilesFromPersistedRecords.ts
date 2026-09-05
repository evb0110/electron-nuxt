import type { IRecentFile } from '@contracts/shared';
import { parseDocumentRef } from '@contracts/documentRef';
import { createEpochMs } from '@contracts/timestamps';
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
        .flatMap<IRecentFile>(record => {
            const originalPath = parseDocumentRef(record.ref);
            if (originalPath === null) {
                return [];
            }
            return [{
                originalPath,
                backend: 'browser',
                fileName: record.saveName ?? record.fileName,
                timestamp: createEpochMs(record.updatedAt),
                fileSize: record.fileSize,
                modifiedAt: createEpochMs(record.updatedAt),
            }];
        });
}
