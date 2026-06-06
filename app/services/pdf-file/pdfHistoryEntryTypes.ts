import type { TDocumentRef } from '@contracts/platformApi';

export interface IByteHistoryEntry {
    kind: 'bytes';
    snapshot: Uint8Array;
}

export interface IPathHistoryEntry {
    kind: 'path';
    path: TDocumentRef;
    size: number;
    originalPath: TDocumentRef | null;
}

export type TPdfHistoryEntry = IByteHistoryEntry | IPathHistoryEntry;
