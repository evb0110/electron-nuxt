import { BROWSER_DOCUMENT_CHUNK_SIZE } from './browserDocumentConstants';
import { groupBy } from 'es-toolkit/array';
import {
    cloneBytes,
    normalizePersistedBytes,
} from './browserDocumentBytes';
import { defaultRetentionForKind } from './browserDocumentStoragePolicy';
import type {
    IBrowserDocumentEntry,
    IBrowserDocumentEntryInput,
    IBrowserPersistedDocumentRecord,
    IChunkKeyRecord,
    TBrowserDocumentStorageMode,
} from './browserDocumentTypes';

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

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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
    const saveKind = normalizePersistedSaveKind(value.saveKind);
    const saveHandle = 'saveHandle' in value
        ? (value.saveHandle as FileSystemFileHandle | null | undefined)
        : undefined;

    return {
        ...(saveName ? { saveName } : {}),
        ...(saveKind ? { saveKind } : {}),
        ...(saveHandle !== undefined ? { saveHandle } : {}),
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
        ...(chunkCount !== undefined ? { chunkCount } : {}),
        ...(chunkSize !== undefined ? { chunkSize } : {}),
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
        ...(sourceRef ? { sourceRef } : {}),
        ...saveTarget,
        storageMode,
        ...chunkLayout,
    };
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
    return new Map(
        Object.entries(groupBy(chunkKeys, chunkKey => chunkKey.ref))
            .map(([
                ref,
                chunks,
            ]) => ([
                ref,
                new Set(chunks.map(chunk => chunk.index)),
            ])),
    );
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

export function createBrowserDocumentEntry(
    input: IBrowserDocumentEntryInput,
): IBrowserDocumentEntry {
    return {
        ref: input.ref,
        fileName: input.fileName,
        mimeType: input.mimeType,
        kind: input.kind,
        retention: input.retention,
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
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
