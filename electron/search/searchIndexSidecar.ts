import {
    open,
    rm,
    stat,
} from 'fs/promises';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

export const COMPACT_SEARCH_INDEX_SCHEMA_VERSION = 1;
export const COMPACT_SEARCH_INDEX_MAGIC = 'EVBSIDX1';
export const COMPACT_SEARCH_INDEX_HEADER_SIZE = 24;
export const COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE = 24;
export const COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC = 0;
export const COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER = 1;

const MAX_UINT32 = 0xFFFFFFFF;
const MAX_UINT16 = 0xFFFF;
const MAX_COMPACT_SEARCH_INDEX_PAGE_RECORDS = 1_000_000;
const MAX_COMPACT_SEARCH_INDEX_PAGE_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_COMPACT_SEARCH_INDEX_TOTAL_TEXT_BYTES = 1024 * 1024 * 1024;
const log = createLogger('search-index-sidecar');

export interface ICompactSearchIndexTextSource {
    kind: number;
    version: number;
}

export interface ICompactSearchIndexPage {
    pageNumber: number;
    text: string;
}

export interface ICompactSearchIndexPayload {
    pageCount: number;
    pages: readonly ICompactSearchIndexPage[];
    textSource?: ICompactSearchIndexTextSource;
}

export interface ICompactSearchIndex {
    pageCount: number;
    pages: ICompactSearchIndexPage[];
    textSource: ICompactSearchIndexTextSource;
}

interface ICompactSearchIndexPageRecord {
    pageNumber: number;
    textUtf16Length: number;
    byteOffset: bigint;
    byteLength: bigint;
}

interface ILoadCompactSearchIndexOptions {
    expectedPageCount?: number;
    minSourceMtimeMs?: number;
    requiredTextSource?: ICompactSearchIndexTextSource;
    signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function isUInt32(value: number) {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_UINT32;
}

function assertUInt32(value: number, label: string) {
    if (!isUInt32(value)) {
        throw new Error(`${label} must fit in an unsigned 32-bit integer`);
    }
}

function assertUInt16(value: number, label: string) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT16) {
        throw new Error(`${label} must fit in an unsigned 16-bit integer`);
    }
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function encodeTextSource(textSource: ICompactSearchIndexTextSource | undefined) {
    if (!textSource) {
        return 0;
    }
    assertUInt16(textSource.kind, 'textSource.kind');
    assertUInt16(textSource.version, 'textSource.version');
    return textSource.kind + textSource.version * 0x10000;
}

function decodeTextSource(value: number): ICompactSearchIndexTextSource {
    return {
        kind: value & MAX_UINT16,
        version: Math.floor(value / 0x10000),
    };
}

function textSourcesMatch(
    actual: ICompactSearchIndexTextSource,
    required: ICompactSearchIndexTextSource | undefined,
) {
    return required === undefined
        || (
            actual.kind === required.kind
            && actual.version === required.version
        );
}

function normalizePages(
    pages: readonly ICompactSearchIndexPage[],
    signal?: AbortSignal,
) {
    const normalizedPages = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
    const seenPageNumbers = new Set<number>();

    for (const page of normalizedPages) {
        throwIfAborted(signal);
        assertUInt32(page.pageNumber, 'pageNumber');
        if (page.pageNumber <= 0) {
            throw new Error('pageNumber must be positive');
        }
        if (seenPageNumbers.has(page.pageNumber)) {
            throw new Error(`Duplicate pageNumber in compact search index: ${page.pageNumber}`);
        }
        if (typeof page.text !== 'string') {
            throw new Error('page text must be a string');
        }
        assertUInt32(page.text.length, 'textUtf16Length');
        seenPageNumbers.add(page.pageNumber);
    }

    return normalizedPages;
}

function createHeaderAndRecords(
    payload: ICompactSearchIndexPayload,
    pages: readonly ICompactSearchIndexPage[],
    signal?: AbortSignal,
) {
    assertUInt32(payload.pageCount, 'pageCount');
    assertUInt32(pages.length, 'pageRecordCount');

    const tableSize = pages.length * COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE;
    const headerAndTableSize = COMPACT_SEARCH_INDEX_HEADER_SIZE + tableSize;
    let nextByteOffset = BigInt(headerAndTableSize);

    const records: ICompactSearchIndexPageRecord[] = pages.map((page) => {
        throwIfAborted(signal);
        const byteLength = BigInt(Buffer.byteLength(page.text, 'utf8'));
        const byteOffset = nextByteOffset;
        nextByteOffset += byteLength;
        return {
            pageNumber: page.pageNumber,
            textUtf16Length: page.text.length,
            byteOffset,
            byteLength,
        };
    });

    const headerAndTable = Buffer.alloc(headerAndTableSize);
    headerAndTable.write(COMPACT_SEARCH_INDEX_MAGIC, 0, 'ascii');
    headerAndTable.writeUInt32LE(COMPACT_SEARCH_INDEX_SCHEMA_VERSION, 8);
    headerAndTable.writeUInt32LE(payload.pageCount, 12);
    headerAndTable.writeUInt32LE(records.length, 16);
    headerAndTable.writeUInt32LE(encodeTextSource(payload.textSource), 20);

    records.forEach((record, recordIndex) => {
        throwIfAborted(signal);
        const offset = COMPACT_SEARCH_INDEX_HEADER_SIZE + recordIndex * COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE;
        headerAndTable.writeUInt32LE(record.pageNumber, offset);
        headerAndTable.writeUInt32LE(record.textUtf16Length, offset + 4);
        headerAndTable.writeBigUInt64LE(record.byteOffset, offset + 8);
        headerAndTable.writeBigUInt64LE(record.byteLength, offset + 16);
    });

    return {
        headerAndTable,
        records,
    };
}

async function writeBufferAt(
    file: Awaited<ReturnType<typeof open>>,
    buffer: Buffer,
    position: number,
    signal?: AbortSignal,
) {
    let offset = 0;
    while (offset < buffer.byteLength) {
        throwIfAborted(signal);
        const { bytesWritten } = await file.write(
            buffer,
            offset,
            buffer.byteLength - offset,
            position + offset,
        );
        if (bytesWritten <= 0) {
            throw new Error('Failed to write compact search index buffer');
        }
        offset += bytesWritten;
    }
}

async function readBufferAt(
    file: Awaited<ReturnType<typeof open>>,
    buffer: Buffer,
    position: number,
    signal?: AbortSignal,
) {
    let offset = 0;
    while (offset < buffer.byteLength) {
        throwIfAborted(signal);
        const { bytesRead } = await file.read(
            buffer,
            offset,
            buffer.byteLength - offset,
            position + offset,
        );
        if (bytesRead <= 0) {
            return false;
        }
        offset += bytesRead;
    }
    return true;
}

async function writeCompactSearchIndexPayload(
    targetPath: string,
    payload: ICompactSearchIndexPayload,
    signal?: AbortSignal,
) {
    const pages = normalizePages(payload.pages, signal);
    const {
        headerAndTable,
        records,
    } = createHeaderAndRecords(payload, pages, signal);

    const file = await open(targetPath, 'w');
    try {
        await writeBufferAt(file, headerAndTable, 0, signal);
        for (const [
            pageIndex,
            page,
        ] of pages.entries()) {
            throwIfAborted(signal);
            const record = records[pageIndex];
            if (!record) {
                throw new Error(`Missing compact search index record for page ${page.pageNumber}`);
            }
            const textBuffer = Buffer.from(page.text, 'utf8');
            await writeBufferAt(file, textBuffer, Number(record.byteOffset), signal);
        }
    } finally {
        await file.close();
    }
}

function parseHeader(header: Buffer) {
    if (header.toString('ascii', 0, 8) !== COMPACT_SEARCH_INDEX_MAGIC) {
        return null;
    }

    const schemaVersion = header.readUInt32LE(8);
    if (schemaVersion !== COMPACT_SEARCH_INDEX_SCHEMA_VERSION) {
        return null;
    }

    return {
        pageCount: header.readUInt32LE(12),
        pageRecordCount: header.readUInt32LE(16),
        textSource: decodeTextSource(header.readUInt32LE(20)),
    };
}

function parsePageRecords(
    table: Buffer,
    fileSize: number,
) {
    const records: ICompactSearchIndexPageRecord[] = [];
    const seenPageNumbers = new Set<number>();
    const fileSizeBigInt = BigInt(fileSize);

    for (
        let offset = 0;
        offset < table.byteLength;
        offset += COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE
    ) {
        const pageNumber = table.readUInt32LE(offset);
        const textUtf16Length = table.readUInt32LE(offset + 4);
        const byteOffset = table.readBigUInt64LE(offset + 8);
        const byteLength = table.readBigUInt64LE(offset + 16);
        if (pageNumber <= 0 || seenPageNumbers.has(pageNumber)) {
            return null;
        }
        if (byteOffset + byteLength > fileSizeBigInt || byteLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            return null;
        }
        seenPageNumbers.add(pageNumber);
        records.push({
            pageNumber,
            textUtf16Length,
            byteOffset,
            byteLength,
        });
    }

    return records;
}

async function readPages(
    file: Awaited<ReturnType<typeof open>>,
    records: readonly ICompactSearchIndexPageRecord[],
    signal?: AbortSignal,
) {
    const pages: ICompactSearchIndexPage[] = [];
    for (const record of records) {
        throwIfAborted(signal);
        const textBuffer = Buffer.alloc(Number(record.byteLength));
        const readOk = await readBufferAt(file, textBuffer, Number(record.byteOffset), signal);
        if (!readOk) {
            return null;
        }
        const text = textBuffer.toString('utf8');
        if (text.length !== record.textUtf16Length) {
            return null;
        }
        pages.push({
            pageNumber: record.pageNumber,
            text,
        });
    }
    return pages.sort((a, b) => a.pageNumber - b.pageNumber);
}

function isFreshEnough(
    sidecarMtimeMs: number | undefined,
    minSourceMtimeMs: number | undefined,
) {
    if (typeof minSourceMtimeMs !== 'number' || !Number.isFinite(minSourceMtimeMs)) {
        return true;
    }
    return typeof sidecarMtimeMs === 'number'
        && Number.isFinite(sidecarMtimeMs)
        && sidecarMtimeMs >= minSourceMtimeMs;
}

function coversExpectedPages(
    pageCount: number,
    pageRecordCount: number,
    expectedPageCount: number | undefined,
) {
    if (!isPositiveInteger(expectedPageCount)) {
        return true;
    }
    return pageCount >= expectedPageCount && pageRecordCount >= expectedPageCount;
}

function recordsFitLoadBudget(records: readonly ICompactSearchIndexPageRecord[]) {
    let totalTextBytes = BigInt(0);
    for (const record of records) {
        if (record.byteLength > BigInt(MAX_COMPACT_SEARCH_INDEX_PAGE_TEXT_BYTES)) {
            return false;
        }
        totalTextBytes += record.byteLength;
        if (totalTextBytes > BigInt(MAX_COMPACT_SEARCH_INDEX_TOTAL_TEXT_BYTES)) {
            return false;
        }
    }
    return true;
}

export function getCompactSearchIndexPath(pdfPath: string) {
    return `${pdfPath}.index.evb-search-v1.bin`;
}

export async function persistCompactSearchIndex(
    pdfPath: string,
    payload: ICompactSearchIndexPayload,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const indexPath = getCompactSearchIndexPath(pdfPath);
    const tempPath = makeSiblingTempPath(indexPath);
    try {
        await writeCompactSearchIndexPayload(tempPath, payload, signal);
        throwIfAborted(signal);
        await atomicReplace(tempPath, indexPath);
        log.debug(`Compact search index saved successfully: ${indexPath}`);
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export async function persistCompactSearchIndexBestEffort(
    pdfPath: string,
    payload: ICompactSearchIndexPayload,
    signal?: AbortSignal,
) {
    try {
        await persistCompactSearchIndex(pdfPath, payload, signal);
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        log.debug(`Failed to save compact search index: ${getErrorMessage(error)}`);
    }
}

export async function loadCompactSearchIndex(
    pdfPath: string,
    options: ILoadCompactSearchIndexOptions = {},
): Promise<ICompactSearchIndex | null> {
    const indexPath = getCompactSearchIndexPath(pdfPath);
    const {
        expectedPageCount,
        minSourceMtimeMs,
        requiredTextSource,
        signal,
    } = options;

    try {
        throwIfAborted(signal);
        const indexStat = await stat(indexPath);
        if (!isFreshEnough(indexStat.mtimeMs, minSourceMtimeMs)) {
            return null;
        }

        const file = await open(indexPath, 'r');
        try {
            const header = Buffer.alloc(COMPACT_SEARCH_INDEX_HEADER_SIZE);
            if (!(await readBufferAt(file, header, 0, signal))) {
                return null;
            }

            const metadata = parseHeader(header);
            if (
                !metadata
                || !coversExpectedPages(metadata.pageCount, metadata.pageRecordCount, expectedPageCount)
                || !textSourcesMatch(metadata.textSource, requiredTextSource)
                || metadata.pageRecordCount > MAX_COMPACT_SEARCH_INDEX_PAGE_RECORDS
            ) {
                return null;
            }

            const tableSize = metadata.pageRecordCount * COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE;
            const minimumSize = COMPACT_SEARCH_INDEX_HEADER_SIZE + tableSize;
            if (
                !Number.isSafeInteger(tableSize)
                || !Number.isSafeInteger(minimumSize)
                || indexStat.size < minimumSize
            ) {
                return null;
            }

            const table = Buffer.alloc(tableSize);
            if (!(await readBufferAt(file, table, COMPACT_SEARCH_INDEX_HEADER_SIZE, signal))) {
                return null;
            }

            const records = parsePageRecords(table, indexStat.size);
            if (!records || !recordsFitLoadBudget(records)) {
                return null;
            }

            const pages = await readPages(file, records, signal);
            if (!pages) {
                return null;
            }

            return {
                pageCount: metadata.pageCount,
                pages,
                textSource: metadata.textSource,
            };
        } finally {
            await file.close();
        }
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        log.debug(`Compact search index not available: ${getErrorMessage(error)}`);
        return null;
    }
}
