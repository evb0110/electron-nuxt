import type { IRecentFile } from '@contracts/shared';
import { decodeDocumentRefSegment } from '@app/utils/document-ref';

export const BROWSER_REF_PREFIX = 'browser://documents/';
export const DB_NAME = 'evb-viewer-browser-documents';
export const DB_VERSION = 2;
export const DOCUMENTS_STORE = 'documents';
export const DOCUMENT_CHUNKS_STORE = 'document-chunks';
export const BROWSER_DOCUMENT_CHUNK_SIZE = 4 * 1024 * 1024;
const BROWSER_INLINE_FILE_THRESHOLD_BYTES = 16 * 1024 * 1024;
export const BROWSER_MAX_FULL_READ_BYTES = 64 * 1024 * 1024;
export const BROWSER_MAX_RECENT_FILES = 30;
export const BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES = 512 * 1024 * 1024;
export const BROWSER_CHUNK_WRITE_YIELD_EVERY = 2;

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
    saveName?: string;
    saveKind?: 'pdf' | 'docx' | 'generic';
    saveHandle?: FileSystemFileHandle | null;
    storageMode?: TBrowserDocumentStorageMode;
    chunkCount?: number;
    chunkSize?: number;
}

export interface IBrowserDocumentEntry extends IBrowserPersistedDocumentRecord {
    pendingLoad: Promise<void> | null;
    retention: 'durable' | 'transient';
    saveName?: string;
    saveKind: 'pdf' | 'docx' | 'generic';
    saveHandle?: FileSystemFileHandle | null;
    storageMode: TBrowserDocumentStorageMode;
    chunkCount: number;
    chunkSize: number;
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
}

export interface IWriteDocumentOptions { unloadAfterPersist?: boolean; }

export interface IBrowserDocumentChunkRecord {
    key: string;
    ref: string;
    index: number;
    data: Uint8Array;
}

export interface IChunkKeyRecord {
    ref: string;
    index: number;
}

type TPersistedDocumentKind = IBrowserPersistedDocumentRecord['kind'];

interface IPersistedDocumentRequiredFields {
    ref: string;
    fileName: string;
    mimeType: string;
    kind: TPersistedDocumentKind;
    data: Uint8Array;
    fileSize: number;
    updatedAt: number;
}

interface IPersistedSaveTarget {
    saveName?: string;
    saveKind?: IBrowserDocumentEntry['saveKind'];
    saveHandle?: FileSystemFileHandle | null;
}

interface IPersistedChunkLayout {
    chunkCount?: number;
    chunkSize?: number;
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
    saveKind: IBrowserDocumentEntry['saveKind'];
    saveHandle: FileSystemFileHandle | null;
    storageMode: TBrowserDocumentStorageMode;
    chunkCount?: number;
    chunkSize?: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function getDocumentFileName(ref: string) {
    const trimmed = ref.startsWith(BROWSER_REF_PREFIX)
        ? ref.slice(BROWSER_REF_PREFIX.length)
        : ref;

    return decodeDocumentRefSegment(trimmed.split('/').at(-1) ?? 'document');
}

export function createBrowserDocumentRef(fileName: string) {
    return `${BROWSER_REF_PREFIX}${crypto.randomUUID()}/${encodeURIComponent(fileName)}`;
}

export function defaultRetentionForKind(kind: IBrowserDocumentEntry['kind']) {
    return kind === 'working' ? 'transient' : 'durable';
}

export function toUint8Array(data: Uint8Array | ArrayBuffer) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function cloneBytes(data: Uint8Array) {
    return data.slice();
}

export function normalizePersistedBytes(data: unknown) {
    if (data instanceof Uint8Array) {
        return data;
    }

    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }

    return null;
}

function normalizeStorageMode(value: unknown): TBrowserDocumentStorageMode {
    if (
        value === 'handle'
        || value === 'chunked'
        || value === 'source-proxy'
    ) {
        return value;
    }

    return 'inline';
}

function normalizePersistedKind(value: unknown): TPersistedDocumentKind | null {
    if (value === 'source' || value === 'working' || value === 'output') {
        return value;
    }

    return null;
}

function readRequiredString(value: unknown) {
    return typeof value === 'string' ? value : null;
}

function readRequiredNumber(value: unknown) {
    return typeof value === 'number' ? value : null;
}

function readPersistedDocumentRequiredFields(
    value: Record<string, unknown>,
): IPersistedDocumentRequiredFields | null {
    const ref = readRequiredString(value.ref);
    const fileName = readRequiredString(value.fileName);
    const mimeType = readRequiredString(value.mimeType);
    const kind = normalizePersistedKind(value.kind);
    const data = normalizePersistedBytes(value.data);
    const fileSize = readRequiredNumber(value.fileSize);
    const updatedAt = readRequiredNumber(value.updatedAt);

    if (!ref || !fileName || !mimeType || !kind || !data || fileSize === null || updatedAt === null) {
        return null;
    }

    return {
        ref,
        fileName,
        mimeType,
        kind,
        data,
        fileSize,
        updatedAt,
    };
}

function normalizePersistedSaveKind(
    value: unknown,
): IBrowserDocumentEntry['saveKind'] | undefined {
    if (value === 'pdf' || value === 'docx' || value === 'generic') {
        return value;
    }

    return undefined;
}

function normalizePersistedSaveTarget(
    value: Record<string, unknown>,
): IPersistedSaveTarget {
    const saveName =
        typeof value.saveName === 'string' ? value.saveName : undefined;
    const saveHandle = 'saveHandle' in value
        ? (value.saveHandle as FileSystemFileHandle | null | undefined)
        : undefined;

    return {
        saveName,
        saveKind: normalizePersistedSaveKind(value.saveKind),
        saveHandle: saveHandle ?? undefined,
    };
}

function normalizePersistedChunkLayout(
    value: Record<string, unknown>,
): IPersistedChunkLayout {
    const chunkCount =
        typeof value.chunkCount === 'number' && value.chunkCount >= 0
            ? Math.floor(value.chunkCount)
            : undefined;
    const chunkSize =
        typeof value.chunkSize === 'number' && value.chunkSize > 0
            ? Math.floor(value.chunkSize)
            : undefined;

    return {
        chunkCount,
        chunkSize,
    };
}

export function toPersistedDocumentRecord(
    value: unknown,
): IBrowserPersistedDocumentRecord | null {
    if (!isRecord(value)) {
        return null;
    }

    const requiredFields = readPersistedDocumentRequiredFields(value);
    if (!requiredFields) {
        return null;
    }

    const retention = value.retention;
    const sourceRef =
        typeof value.sourceRef === 'string' ? value.sourceRef : undefined;
    const saveTarget = normalizePersistedSaveTarget(value);
    const storageMode = normalizeStorageMode(value.storageMode);
    const chunkLayout = normalizePersistedChunkLayout(value);

    return {
        ...requiredFields,
        retention: retention === 'transient' ? 'transient' : 'durable',
        sourceRef,
        ...saveTarget,
        storageMode,
        ...chunkLayout,
    };
}

export function buildBrowserDocumentFullReadError(fileName: string, fileSize: number) {
    return new Error(
        `Browser document is too large to load fully into memory (${fileName}: `
        + `${Math.floor(fileSize / (1024 * 1024))}MB > `
        + `${Math.floor(BROWSER_MAX_FULL_READ_BYTES / (1024 * 1024))}MB limit)`,
    );
}

export function normalizePersistedWriteBytes(
    data: Uint8Array | ArrayBuffer,
    cloneData = true,
) {
    const bytes = toUint8Array(data);
    return cloneData ? cloneBytes(bytes) : bytes;
}

function defaultSaveKindForFileName(fileName: string): IBrowserDocumentEntry['saveKind'] {
    if (/\.pdf$/i.test(fileName)) {
        return 'pdf';
    }

    if (/\.docx$/i.test(fileName)) {
        return 'docx';
    }

    return 'generic';
}

export function createEntryFromPersistedRecord(
    record: IBrowserPersistedDocumentRecord,
): IBrowserDocumentEntry {
    return {
        ...record,
        data: cloneBytes(record.data),
        pendingLoad: null,
        retention: record.retention ?? defaultRetentionForKind(record.kind),
        saveName: record.saveName ?? record.fileName,
        saveKind: record.saveKind ?? defaultSaveKindForFileName(record.fileName),
        saveHandle: record.saveHandle ?? null,
        storageMode: record.storageMode ?? 'inline',
        chunkCount: record.chunkCount ?? 0,
        chunkSize: record.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
    };
}

export function collectChunkIndicesByRef(chunkKeys: IChunkKeyRecord[]) {
    const chunkIndicesByRef = new Map<string, Set<number>>();
    for (const chunkKey of chunkKeys) {
        let refChunks = chunkIndicesByRef.get(chunkKey.ref);
        if (!refChunks) {
            refChunks = new Set<number>();
            chunkIndicesByRef.set(chunkKey.ref, refChunks);
        }
        refChunks.add(chunkKey.index);
    }
    return chunkIndicesByRef;
}

export function isChunkedRecordMissingChunks(
    record: IBrowserPersistedDocumentRecord,
    chunkIndicesByRef: Map<string, Set<number>>,
) {
    const chunkCount = record.chunkCount ?? 0;
    if (record.storageMode !== 'chunked' || chunkCount <= 0) {
        return false;
    }

    const chunkIndices = chunkIndicesByRef.get(record.ref);
    if (!chunkIndices) {
        return true;
    }

    for (let index = 0; index < chunkCount; index += 1) {
        if (!chunkIndices.has(index)) {
            return true;
        }
    }

    return false;
}

export function countNonWorkingDependents(records: IBrowserPersistedDocumentRecord[]) {
    const dependentCounts = new Map<string, number>();
    for (const record of records) {
        if (!record.sourceRef || record.kind === 'working') {
            continue;
        }

        dependentCounts.set(
            record.sourceRef,
            (dependentCounts.get(record.sourceRef) ?? 0) + 1,
        );
    }
    return dependentCounts;
}

export function shouldRemovePersistedRecord(
    record: IBrowserPersistedDocumentRecord,
    recentRefs: Set<string>,
    nonWorkingDependentCounts: Map<string, number>,
) {
    return (
        record.kind === 'working'
        || (
            !recentRefs.has(record.ref)
            && (nonWorkingDependentCounts.get(record.ref) ?? 0) === 0
        )
    );
}

export function normalizeReadRange(offset: number, length: number) {
    const start = Math.max(0, Math.floor(offset));
    const rangeLength = Math.max(0, Math.floor(length));

    return {
        start,
        rangeLength,
        end: start + rangeLength,
    };
}

export function shouldInlineFileBytes(fileSize: number) {
    return fileSize <= BROWSER_INLINE_FILE_THRESHOLD_BYTES;
}

export function resolveByteBackedStorageMode(fileSize: number): TBrowserDocumentStorageMode {
    return shouldInlineFileBytes(fileSize) ? 'inline' : 'chunked';
}

export function resolveStoredDocumentStorageMode(
    byteLength: number,
    requestedStorageMode?: TBrowserDocumentStorageMode,
): TBrowserDocumentStorageMode {
    const storageMode =
        requestedStorageMode ?? resolveByteBackedStorageMode(byteLength);

    if (storageMode === 'source-proxy') {
        return 'source-proxy';
    }

    if (storageMode === 'handle') {
        return byteLength > 0
            ? resolveByteBackedStorageMode(byteLength)
            : 'handle';
    }

    if (storageMode === 'inline') {
        return resolveByteBackedStorageMode(byteLength);
    }

    return storageMode;
}

export function createBrowserDocumentEntry(
    input: IBrowserDocumentEntryInput,
): IBrowserDocumentEntry {
    return {
        ref: input.ref,
        fileName: input.fileName,
        mimeType: input.mimeType,
        kind: input.kind,
        retention: input.retention,
        sourceRef: input.sourceRef,
        data: input.data,
        fileSize: input.fileSize,
        updatedAt: Date.now(),
        pendingLoad: null,
        saveName: input.fileName,
        saveKind: input.saveKind,
        saveHandle: input.saveHandle,
        storageMode: input.storageMode,
        chunkCount: input.chunkCount ?? 0,
        chunkSize: input.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
    };
}

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
            fileName: record.saveName ?? record.fileName,
            timestamp: record.updatedAt,
            fileSize: record.fileSize,
        }));
}
