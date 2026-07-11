import type { TDocumentRevisionToken } from '@contracts/documentRevision';

export type TBrowserDocumentStorageMode =
    | 'inline'
    | 'handle'
    | 'chunked'
    | 'source-proxy';

export interface IBrowserPersistedDocumentRecord {
    ref: string;
    fileName: string;
    mimeType: string;
    kind: 'source' | 'working' | 'output';
    retention?: 'durable' | 'transient';
    sourceRef?: string;
    data: Uint8Array;
    fileSize: number;
    updatedAt: number;
    contentToken?: string;
    contentRevision?: number;
    saveName?: string;
    saveKind?: 'pdf' | 'docx' | 'generic';
    saveHandle?: FileSystemFileHandle | null;
    storageMode?: TBrowserDocumentStorageMode;
    chunkCount?: number;
    chunkSize?: number;
    chunkGeneration?: string;
}

export interface IBrowserDocumentEntry extends IBrowserPersistedDocumentRecord {
    /** Volatile runtime state: persistence failed, so unloading would lose the document. */
    memoryOnly?: boolean;
    pendingLoad: Promise<void> | null;
    retention: 'durable' | 'transient';
    saveName?: string;
    saveKind: 'pdf' | 'docx' | 'generic';
    saveHandle?: FileSystemFileHandle | null;
    storageMode: TBrowserDocumentStorageMode;
    chunkCount: number;
    chunkSize: number;
    chunkGeneration?: string;
    pendingChunkGeneration?: string;
    pendingChunkCount?: number;
    pendingChunkSize?: number;
    pendingFileSize?: number;
}

export interface IRegisterFileOptions {
    kind?: IBrowserDocumentEntry['kind'];
    retention?: IBrowserDocumentEntry['retention'];
    saveKind?: IBrowserDocumentEntry['saveKind'];
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
}

export interface ICreateStoredDocumentOptions {
    mimeType: string;
    saveKind?: IBrowserDocumentEntry['saveKind'];
    kind?: IBrowserDocumentEntry['kind'];
    retention?: IBrowserDocumentEntry['retention'];
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
    storageMode?: TBrowserDocumentStorageMode;
    chunkCount?: number;
    chunkSize?: number;
    chunkGeneration?: string;
}

export interface IWriteDocumentOptions {
    unloadAfterPersist?: boolean;
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    skipDocumentRevisionCheckForBootstrap?: boolean;
}

export interface IBrowserDocumentChunkRecord {
    key: string;
    ref: string;
    index: number;
    generation?: string;
    data: Uint8Array;
}

export interface IChunkKeyRecord {
    ref: string;
    index: number;
    generation?: string;
}

export interface IBrowserDocumentEntryInput {
    ref: string;
    fileName: string;
    mimeType: string;
    kind: IBrowserDocumentEntry['kind'];
    retention: IBrowserDocumentEntry['retention'];
    sourceRef?: string;
    data: Uint8Array;
    fileSize: number;
    contentToken?: string;
    contentRevision?: number;
    saveKind: IBrowserDocumentEntry['saveKind'];
    saveHandle: FileSystemFileHandle | null;
    storageMode: TBrowserDocumentStorageMode;
    chunkCount?: number;
    chunkSize?: number;
    chunkGeneration?: string;
}
