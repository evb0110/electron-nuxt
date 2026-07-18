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
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    COMPACT_SEARCH_INDEX_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE,
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    createCompactSearchIndexEncoding,
    getCompactSearchIndexPath,
    type ICompactSearchIndexPage,
    type ICompactSearchIndexPageRecord,
    type ICompactSearchIndexPayload,
    type ICompactSearchIndexTextSource,
} from '@contracts/searchIndexSidecar';

export {
    COMPACT_SEARCH_INDEX_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE,
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    getCompactSearchIndexPath,
};
export type {
    ICompactSearchIndexPage,
    ICompactSearchIndexPayload,
    ICompactSearchIndexTextSource,
};

const MAX_UINT16 = 0xFFFF;
const MAX_COMPACT_SEARCH_INDEX_PAGE_RECORDS = 1_000_000;
const MAX_COMPACT_SEARCH_INDEX_PAGE_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_COMPACT_SEARCH_INDEX_TOTAL_TEXT_BYTES = 256 * 1024 * 1024;
const log = createLogger('search-index-sidecar');

export interface ICompactSearchIndex {
    documentRevision: TDocumentRevisionToken;
    pageCount: number;
    pages: ICompactSearchIndexPage[];
    textSource: ICompactSearchIndexTextSource;
}

interface ILoadCompactSearchIndexOptions {
    documentRevision?: TDocumentRevisionToken;
    expectedPageCount?: number;
    minSourceMtimeMs?: number;
    requiredTextSource?: ICompactSearchIndexTextSource;
    metadataOnly?: boolean;
    maxTotalTextBytes?: number;
    signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
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
    const {
        headerAndTable,
        pages,
        records,
    } = createCompactSearchIndexEncoding(payload, () => throwIfAborted(signal));

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
    const headerSize = header.readUInt32LE(12);
    if (headerSize !== COMPACT_SEARCH_INDEX_HEADER_SIZE) {
        return null;
    }

    return {
        pageCount: header.readUInt32LE(16),
        pageRecordCount: header.readUInt32LE(20),
        textSource: decodeTextSource(header.readUInt32LE(24)),
        revisionTokenByteLength: header.readUInt32LE(28),
        revisionTokenByteOffset: header.readBigUInt64LE(32),
        pageTableOffset: header.readBigUInt64LE(40),
        textDataOffset: header.readBigUInt64LE(48),
    };
}

function bigintToSafeNumber(value: bigint) {
    return value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : null;
}

function parsePageRecords(
    table: Buffer,
    fileSize: number,
    textDataOffset: number,
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
        if (
            byteOffset < BigInt(textDataOffset)
            || byteOffset + byteLength > fileSizeBigInt
            || byteLength > BigInt(Number.MAX_SAFE_INTEGER)
        ) {
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

function recordsFitLoadBudget(
    records: readonly ICompactSearchIndexPageRecord[],
    maxTotalTextBytes: number,
) {
    let totalTextBytes = BigInt(0);
    for (const record of records) {
        if (record.byteLength > BigInt(MAX_COMPACT_SEARCH_INDEX_PAGE_TEXT_BYTES)) {
            return false;
        }
        totalTextBytes += record.byteLength;
        if (totalTextBytes > BigInt(maxTotalTextBytes)) {
            return false;
        }
    }
    return true;
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
        documentRevision,
        expectedPageCount,
        minSourceMtimeMs,
        metadataOnly,
        maxTotalTextBytes = MAX_COMPACT_SEARCH_INDEX_TOTAL_TEXT_BYTES,
        requiredTextSource,
        signal,
    } = options;
    if (!documentRevision) {
        return null;
    }

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

            const revisionTokenByteOffset = bigintToSafeNumber(metadata.revisionTokenByteOffset);
            const pageTableOffset = bigintToSafeNumber(metadata.pageTableOffset);
            const textDataOffset = bigintToSafeNumber(metadata.textDataOffset);
            if (
                revisionTokenByteOffset === null
                || pageTableOffset === null
                || textDataOffset === null
                || metadata.revisionTokenByteLength <= 0
            ) {
                return null;
            }
            const revisionTokenEnd = revisionTokenByteOffset + metadata.revisionTokenByteLength;
            const tableSize = metadata.pageRecordCount * COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE;
            const tableEnd = pageTableOffset + tableSize;
            if (
                revisionTokenByteOffset < COMPACT_SEARCH_INDEX_HEADER_SIZE
                || revisionTokenEnd > pageTableOffset
                || textDataOffset < tableEnd
                || !Number.isSafeInteger(tableSize)
                || !Number.isSafeInteger(tableEnd)
                || indexStat.size < textDataOffset
            ) {
                return null;
            }

            const revisionTokenBuffer = Buffer.alloc(metadata.revisionTokenByteLength);
            if (!(await readBufferAt(file, revisionTokenBuffer, revisionTokenByteOffset, signal))) {
                return null;
            }
            if (revisionTokenBuffer.toString('utf8') !== documentRevision) {
                return null;
            }

            const table = Buffer.alloc(tableSize);
            if (!(await readBufferAt(file, table, pageTableOffset, signal))) {
                return null;
            }

            const records = parsePageRecords(table, indexStat.size, textDataOffset);
            if (!records || !recordsFitLoadBudget(records, Math.min(
                MAX_COMPACT_SEARCH_INDEX_TOTAL_TEXT_BYTES,
                Math.max(0, Math.floor(maxTotalTextBytes)),
            ))) {
                return null;
            }

            if (metadataOnly) {
                return {
                    documentRevision,
                    pageCount: metadata.pageCount,
                    pages: [],
                    textSource: metadata.textSource,
                };
            }

            const pages = await readPages(file, records, signal);
            if (!pages) {
                return null;
            }

            return {
                documentRevision,
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
