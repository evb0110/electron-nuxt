import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
    mkdtemp,
    open,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import {
    createPageIdentityDeltaPlan,
    PAGE_IDENTITY_INLINE_PAGE_COUNT,
} from '@electron/file-access/pageIdentityDelta';
import {atomicReplace} from '@electron/utils/atomicReplace';

const STREAM_CHUNK_BYTES = 64 * 1_024;
const MAX_STRING_BYTES = 4 * 1_024 * 1_024;
const SOURCE_CHUNK_COUNT = PAGE_IDENTITY_INLINE_PAGE_COUNT;

export interface IPageIdentitySidecarSource {
    format: 'v1' | 'v2';
    path: string;
}

export interface IPageIdentityStreamingState {
    pageCount: number;
    sidecarSource: IPageIdentitySidecarSource;
}

export interface IPageIdentitySidecarHeader {
    documentRevisionToken?: string;
    pageCount?: number;
    storage?: string;
    version?: number;
}

async function readSidecarPrefix(path: string) {
    const handle = await open(path, 'r').catch(() => null);
    if (!handle) {
        return null;
    }
    try {
        const buffer = Buffer.alloc(STREAM_CHUNK_BYTES);
        const result = await handle.read(buffer, 0, buffer.byteLength, 0);
        return buffer.subarray(0, result.bytesRead).toString('utf8');
    } finally {
        await handle.close();
    }
}

function readJsonStringProperty(prefix: string, property: string) {
    const match = new RegExp(`"${property}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, 'u').exec(prefix);
    if (!match) {
        return undefined;
    }
    try {
        const value: unknown = JSON.parse(match[1]!);
        return typeof value === 'string' ? value : undefined;
    } catch {
        return undefined;
    }
}

export async function readPageIdentitySidecarHeader(path: string): Promise<IPageIdentitySidecarHeader | null> {
    const prefix = await readSidecarPrefix(path);
    if (prefix === null) {
        return null;
    }
    const versionMatch = /"version"\s*:\s*(\d+)/u.exec(prefix);
    const pageCountMatch = /"pageCount"\s*:\s*(\d+)/u.exec(prefix);
    const storage = readJsonStringProperty(prefix, 'storage');
    const documentRevisionToken = readJsonStringProperty(prefix, 'documentRevisionToken');
    return {
        ...(versionMatch === null ? {} : {version: Number(versionMatch[1])}),
        ...(pageCountMatch === null ? {} : {pageCount: Number(pageCountMatch[1])}),
        ...(storage === undefined ? {} : {storage}),
        ...(documentRevisionToken === undefined ? {} : {documentRevisionToken}),
    };
}

type TPageIdentityIdCallback = (id: string) => boolean | undefined | Promise<boolean | undefined>;

interface IPageIdentityIdScanResult {
    count: number;
    foundPageIds: boolean;
}

export class PageIdentitySidecarCorruptError extends Error {
    // fallow-ignore-next-line unused-class-member -- callers inspect this stable corruption code across process boundaries.
    readonly code = 'PAGE_IDENTITY_SIDECAR_CORRUPT';

    constructor(detail: string, options?: ErrorOptions) {
        super(`Page identity sidecar ${detail}`, options);
        this.name = 'PageIdentitySidecarCorruptError';
    }
}

/**
 * Streams pageIds arrays from either sidecar format without retaining them.
 * The whole input must be one JSON object: bytes after it close, unbalanced
 * brackets, or a non-object top-level value reject with a typed corruption
 * error. A callback that returns false stops the scan early and skips the
 * tail check; the full scan at open time is the one that vets the tail.
 */
export async function streamPageIdentityIds(
    path: string,
    onId?: TPageIdentityIdCallback,
): Promise<IPageIdentityIdScanResult> {
    const stream = createReadStream(path, {highWaterMark: STREAM_CHUNK_BYTES});
    const decoder = new StringDecoder('utf8');
    let depth = 0;
    let topLevelClosed = false;
    let inString = false;
    let escaped = false;
    let rawString = '';
    let lastString: string | undefined;
    let expectingPageIdsArray = false;
    let pageIdsArrayDepth = 0;
    let foundPageIds = false;
    let count = 0;
    let stopped = false;

    const scan = async (chunk: string) => {
        for (let index = 0; index < chunk.length && !stopped; index += 1) {
            const character = chunk[index]!;
            if (inString) {
                rawString += character;
                if (rawString.length > MAX_STRING_BYTES) {
                    throw new PageIdentitySidecarCorruptError('string exceeds the bounded sidecar limit');
                }
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (character === '\\') {
                    escaped = true;
                    continue;
                }
                if (character !== '"') {
                    continue;
                }
                inString = false;
                let decoded: unknown;
                try {
                    decoded = JSON.parse(rawString) as unknown;
                } catch (error) {
                    throw new PageIdentitySidecarCorruptError('contains an invalid JSON string', {cause: error});
                }
                rawString = '';
                if (pageIdsArrayDepth === depth) {
                    if (typeof decoded !== 'string' || decoded.length === 0) {
                        throw new PageIdentitySidecarCorruptError('contains an invalid page identity');
                    }
                    count += 1;
                    if (onId && await onId(decoded) === false) {
                        stopped = true;
                        continue;
                    }
                }
                lastString = typeof decoded === 'string' ? decoded : undefined;
                continue;
            }
            if (/\s/u.test(character)) {
                continue;
            }
            if (topLevelClosed) {
                throw new PageIdentitySidecarCorruptError('has trailing bytes after its JSON object');
            }
            if (depth === 0 && character !== '{') {
                throw new PageIdentitySidecarCorruptError('must be a single JSON object');
            }
            if (character === '"') {
                inString = true;
                rawString = '"';
                continue;
            }
            if (character === '{' || character === '[') {
                depth += 1;
                if (character === '[' && expectingPageIdsArray) {
                    pageIdsArrayDepth = depth;
                    foundPageIds = true;
                }
                expectingPageIdsArray = false;
                continue;
            }
            if (character === '}' || character === ']') {
                if (character === ']' && pageIdsArrayDepth === depth) {
                    pageIdsArrayDepth = 0;
                }
                depth -= 1;
                if (depth === 0) {
                    topLevelClosed = true;
                }
                continue;
            }
            if (character === ':') {
                expectingPageIdsArray = lastString === 'pageIds';
                lastString = undefined;
                continue;
            }
            if (character === ',') {
                lastString = undefined;
                continue;
            }
            lastString = undefined;
            if (expectingPageIdsArray) {
                expectingPageIdsArray = false;
            }
        }
    };

    for await (const rawChunk of stream) {
        if (stopped) {
            break;
        }
        if (!(rawChunk instanceof Uint8Array)) {
            throw new Error('Page identity sidecar stream returned a non-binary chunk');
        }
        await scan(decoder.write(rawChunk));
    }
    if (!stopped) {
        await scan(decoder.end());
        if (inString || pageIdsArrayDepth !== 0 || depth !== 0 || !topLevelClosed) {
            throw new PageIdentitySidecarCorruptError('contains incomplete JSON');
        }
    }
    return {
        count,
        foundPageIds,
    };
}

export async function readIdentityAtFromSidecar(
    source: IPageIdentitySidecarSource,
    pageIndex: number,
) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        return undefined;
    }
    let currentPage = 0;
    let result: string | undefined;
    await streamPageIdentityIds(source.path, id => {
        if (currentPage === pageIndex) {
            result = id;
            return false;
        }
        currentPage += 1;
        return undefined;
    });
    return result;
}

interface IPageIdentitySourceCache {
    chunkOffsets: number[];
    directory: string;
    pageCount: number;
    path: string;
}

async function createPageIdentitySourceCache(
    source: IPageIdentitySidecarSource,
    expectedPageCount: number,
): Promise<IPageIdentitySourceCache> {
    const directory = await mkdtemp(join(tmpdir(), `evb-page-identity-${randomUUID()}-`));
    const path = join(directory, 'ids.ndjson');
    const chunkOffsets: number[] = [];
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let pending = '';
    let pendingBytes = 0;
    let bytesWritten = 0;
    let pageCount = 0;
    let completed = false;
    const flush = async () => {
        if (pending.length === 0) {
            return;
        }
        if (!handle) {
            throw new Error('Page identity source cache is closed');
        }
        await handle.write(pending);
        bytesWritten += pendingBytes;
        pending = '';
        pendingBytes = 0;
    };

    try {
        handle = await open(path, 'w');
        const scan = await streamPageIdentityIds(source.path, async id => {
            if (pageCount % SOURCE_CHUNK_COUNT === 0) {
                chunkOffsets.push(bytesWritten + pendingBytes);
            }
            const line = `${JSON.stringify(id)}\n`;
            pending += line;
            pendingBytes += Buffer.byteLength(line, 'utf8');
            pageCount += 1;
            if (pendingBytes >= STREAM_CHUNK_BYTES) {
                await flush();
            }
            return undefined;
        });
        await flush();
        if (!scan.foundPageIds || scan.count !== pageCount || pageCount !== expectedPageCount) {
            throw new Error(`Page identity sidecar contains ${pageCount} page IDs, expected ${expectedPageCount}`);
        }
        completed = true;
        return {
            chunkOffsets,
            directory,
            pageCount,
            path,
        };
    } finally {
        await handle?.close().catch(() => undefined);
        if (!completed) {
            await rm(directory, {
                force: true,
                recursive: true,
            }).catch(() => undefined);
        }
    }
}

async function readPageIdentitySourceCacheRange(
    source: IPageIdentitySourceCache,
    startPageIndex: number,
    count: number,
) {
    if (
        !Number.isSafeInteger(startPageIndex)
        || startPageIndex < 0
        || !Number.isSafeInteger(count)
        || count < 0
        || count > SOURCE_CHUNK_COUNT
        || startPageIndex + count > source.pageCount
    ) {
        throw new Error('Page identity source range exceeds the bounded read limit');
    }
    if (count === 0) {
        return [];
    }
    const chunkIndex = Math.floor(startPageIndex / SOURCE_CHUNK_COUNT);
    const chunkStartPage = chunkIndex * SOURCE_CHUNK_COUNT;
    const offset = source.chunkOffsets[chunkIndex];
    if (offset === undefined) {
        throw new Error('Page identity source chunk offset is missing');
    }
    const stream = createReadStream(source.path, {
        highWaterMark: STREAM_CHUNK_BYTES,
        start: offset,
    });
    const decoder = new StringDecoder('utf8');
    const identities: string[] = [];
    let pending = '';
    let currentPageIndex = chunkStartPage;
    let complete = false;
    const consume = (chunk: string) => {
        pending += chunk;
        let newlineIndex = pending.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = pending.slice(0, newlineIndex);
            pending = pending.slice(newlineIndex + 1);
            if (line.length === 0) {
                throw new Error('Page identity source contains an empty identity line');
            }
            let value: unknown;
            try {
                value = JSON.parse(line) as unknown;
            } catch (error) {
                throw new Error('Page identity source contains invalid JSON', {cause: error});
            }
            if (typeof value !== 'string' || value.length === 0) {
                throw new Error('Page identity source contains an invalid identity');
            }
            if (currentPageIndex >= startPageIndex) {
                identities.push(value);
                if (identities.length === count) {
                    complete = true;
                    return;
                }
            }
            currentPageIndex += 1;
            newlineIndex = pending.indexOf('\n');
        }
    };
    try {
        for await (const rawChunk of stream) {
            if (!(rawChunk instanceof Uint8Array)) {
                throw new Error('Page identity source stream returned a non-binary chunk');
            }
            consume(decoder.write(rawChunk));
            if (complete) {
                break;
            }
        }
        if (!complete) {
            consume(decoder.end());
            if (pending.length > 0) {
                throw new Error('Page identity source contains an incomplete identity line');
            }
        }
    } finally {
        stream.destroy();
    }
    if (identities.length !== count) {
        throw new Error('Page identity source ended before the requested range');
    }
    return identities;
}

export async function writeIdentityStateFromSidecarSource(
    sidecarPath: string,
    state: IPageIdentityStreamingState,
    delta: IPageIdentityDelta,
    documentRevisionToken: string,
    sidecarVersion: number,
    derivePageIdentity: (identitySeed: string, identityOffset: number) => string,
) {
    const {
        nextPageCount,
        parts,
    } = createPageIdentityDeltaPlan(state.pageCount, delta);
    const source = await createPageIdentitySourceCache(state.sidecarSource, state.pageCount);
    const tempPath = `${sidecarPath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const identitySeed = `migrated:${randomUUID()}`;
    let destinationPage = 1;
    let firstRange = true;
    let firstIdentity = true;
    let pendingIdentities: string[] = [];
    const writeInline = nextPageCount <= SOURCE_CHUNK_COUNT;

    try {
        handle = await open(tempPath, 'w');
        const header = JSON.stringify({
            version: sidecarVersion,
            storage: 'ranges',
            documentRevisionToken,
            pageCount: nextPageCount,
            identitySeed,
        });
        await handle.write(`${header.slice(0, -1)},"${writeInline ? 'pageIds' : 'ranges'}":[`);
        const flushPending = async () => {
            if (writeInline || pendingIdentities.length === 0) {
                return;
            }
            const range = {
                startPage: destinationPage,
                count: pendingIdentities.length,
                identitySeed,
                identityStart: 0,
                pageIds: pendingIdentities,
            };
            await handle!.write(
                `${firstRange ? '' : ','}${JSON.stringify(range)}`,
            );
            firstRange = false;
            destinationPage += pendingIdentities.length;
            pendingIdentities = [];
        };
        const appendIdentity = async (id: string) => {
            if (writeInline) {
                if (!handle) {
                    throw new Error('Page identity sidecar writer is closed');
                }
                await handle.write(`${firstIdentity ? '' : ','}${JSON.stringify(id)}`);
                firstIdentity = false;
                destinationPage += 1;
                return;
            }
            pendingIdentities.push(id);
            if (pendingIdentities.length >= SOURCE_CHUNK_COUNT) {
                await flushPending();
            }
        };
        const appendDerivedRange = async (identitySeed: string, count: number) => {
            if (writeInline) {
                for (let offset = 0; offset < count; offset += 1) {
                    await appendIdentity(derivePageIdentity(identitySeed, offset));
                }
                return;
            }
            await flushPending();
            if (!handle) {
                throw new Error('Page identity sidecar writer is closed');
            }
            const range = {
                startPage: destinationPage,
                count,
                identitySeed,
                identityStart: 0,
            };
            await handle.write(
                `${firstRange ? '' : ','}${JSON.stringify(range)}`,
            );
            firstRange = false;
            destinationPage += count;
        };
        const appendSourceRange = async (fromPageNumber: number, count: number) => {
            for (let offset = 0; offset < count; offset += SOURCE_CHUNK_COUNT) {
                const identities = await readPageIdentitySourceCacheRange(
                    source,
                    fromPageNumber - 1 + offset,
                    Math.min(SOURCE_CHUNK_COUNT, count - offset),
                );
                for (const id of identities) {
                    await appendIdentity(id);
                }
            }
        };

        for (const part of parts) {
            if (part.kind === 'source') {
                await appendSourceRange(part.fromPageNumber, part.count);
                continue;
            }
            if (part.insertedIds !== undefined) {
                for (const id of part.insertedIds) {
                    await appendIdentity(id);
                }
                continue;
            }
            await appendDerivedRange(part.identitySeed, part.count);
        }
        await flushPending();
        if (destinationPage !== nextPageCount + 1) {
            throw new Error('Page identity migration produced the wrong page count');
        }
        await handle.write(']}');
        await handle.close();
        handle = undefined;
        await atomicReplace(tempPath, sidecarPath);
    } catch (error) {
        await rm(tempPath, {force: true}).catch(() => undefined);
        throw error;
    } finally {
        await handle?.close().catch(() => undefined);
        await rm(source.directory, {
            force: true,
            recursive: true,
        }).catch(() => undefined);
    }
}
