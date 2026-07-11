import {
    existsSync,
    statSync,
} from 'fs';
import {
    open as openFileHandle,
    readFile,
} from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { extname } from 'path';
import { MAX_CHUNK } from '@electron/config/constants';
import { onWorkingCopyMutationSettled } from '@electron/file-access/workingCopyMutationQueue';
import {
    assertWithinIpcReadBudget,
    isAllowedBinaryReadExtension,
    normalizeNonEmptyPath,
    resolveExistingReadableBinaryPath,
    resolveReadablePath,
    resolveReadablePathSync,
} from '@electron/features/documents/main/documentFilePathResolution';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';

const ALLOWED_READ_EXTENSIONS = new Set([
    '.json',
    '.txt',
    '.tsv',
]);
const RANGE_READ_HANDLE_CACHE_LIMIT = 6;
const RANGE_READ_HANDLE_IDLE_MS = 30_000;
const RANGE_READ_GLOBAL_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
const RANGE_READ_PER_DOCUMENT_IN_FLIGHT_BYTES = 8 * 1024 * 1024;

interface IRangeReadHandleCacheEntry {
    handle: FileHandle;
    mtimeMs: number;
    size: number;
    epoch: number;
    activeReads: number;
    closeRequested: boolean;
    closed: boolean;
    closePromise: Promise<void> | null;
    idleTimer: ReturnType<typeof setTimeout> | null;
}

interface IRangeReadHandleLease {
    handle: FileHandle;
    release(): Promise<void>;
}

const rangeReadHandles = new Map<string, IRangeReadHandleCacheEntry>();
const rangeReadHandleOpens = new Map<string, Promise<IRangeReadHandleCacheEntry>>();
const rangeReadPathEpochs = new Map<string, number>();
const pendingRangeReads = new Map<string, Promise<Uint8Array>>();
const rangeReadBytesByPath = new Map<string, number>();
let rangeReadGlobalBytes = 0;
const rangeReadBudgetWaiters: Array<{
    path: string;
    bytes: number;
    resolve: () => void;
}> = [];

function canReserveRangeRead(path: string, bytes: number) {
    return rangeReadGlobalBytes + bytes <= RANGE_READ_GLOBAL_IN_FLIGHT_BYTES
        && (rangeReadBytesByPath.get(path) ?? 0) + bytes <= RANGE_READ_PER_DOCUMENT_IN_FLIGHT_BYTES;
}

function reserveRangeRead(path: string, bytes: number) {
    rangeReadGlobalBytes += bytes;
    rangeReadBytesByPath.set(path, (rangeReadBytesByPath.get(path) ?? 0) + bytes);
}

function pumpRangeReadBudgetWaiters() {
    for (let index = 0; index < rangeReadBudgetWaiters.length;) {
        const waiter = rangeReadBudgetWaiters[index]!;
        if (!canReserveRangeRead(waiter.path, waiter.bytes)) {
            index += 1;
            continue;
        }
        rangeReadBudgetWaiters.splice(index, 1);
        reserveRangeRead(waiter.path, waiter.bytes);
        waiter.resolve();
    }
}

async function acquireRangeReadBudget(path: string, bytes: number) {
    if (!canReserveRangeRead(path, bytes)) {
        await new Promise<void>((resolve) => {
            rangeReadBudgetWaiters.push({
                path,
                bytes,
                resolve,
            });
        });
    } else {
        reserveRangeRead(path, bytes);
    }
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        rangeReadGlobalBytes -= bytes;
        const remaining = (rangeReadBytesByPath.get(path) ?? bytes) - bytes;
        if (remaining > 0) {
            rangeReadBytesByPath.set(path, remaining);
        } else {
            rangeReadBytesByPath.delete(path);
        }
        pumpRangeReadBudgetWaiters();
    };
}

function getRangeReadPathEpoch(resolvedPath: string) {
    return rangeReadPathEpochs.get(resolvedPath) ?? 0;
}

function advanceRangeReadPathEpoch(resolvedPath: string) {
    const nextEpoch = getRangeReadPathEpoch(resolvedPath) + 1;
    rangeReadPathEpochs.set(resolvedPath, nextEpoch);
    return nextEpoch;
}

function pruneRangeReadPathEpochIfUnused(resolvedPath: string) {
    if (!rangeReadHandles.has(resolvedPath) && !rangeReadHandleOpens.has(resolvedPath)) {
        rangeReadPathEpochs.delete(resolvedPath);
    }
}

function closeRangeReadHandleEntryWhenUnused(entry: IRangeReadHandleCacheEntry) {
    if (entry.activeReads > 0 || entry.closed) {
        return entry.closePromise ?? Promise.resolve();
    }
    entry.closed = true;
    entry.closePromise = entry.handle.close().catch(() => undefined);
    return entry.closePromise;
}

function requestRangeReadHandleClose(
    resolvedPath: string,
    entry: IRangeReadHandleCacheEntry,
) {
    if (rangeReadHandles.get(resolvedPath) === entry) {
        rangeReadHandles.delete(resolvedPath);
    }
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
    entry.closeRequested = true;
    return closeRangeReadHandleEntryWhenUnused(entry);
}

function scheduleRangeReadHandleIdleClose(
    resolvedPath: string,
    entry: IRangeReadHandleCacheEntry,
) {
    if (entry.activeReads > 0 || entry.closeRequested || entry.closed) {
        return;
    }
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
    }
    entry.idleTimer = setTimeout(() => {
        const currentEntry = rangeReadHandles.get(resolvedPath);
        if (currentEntry !== entry) {
            return;
        }
        void requestRangeReadHandleClose(resolvedPath, entry)
            .finally(() => pruneRangeReadPathEpochIfUnused(resolvedPath));
    }, RANGE_READ_HANDLE_IDLE_MS);
    (entry.idleTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

async function closeCachedRangeReadHandle(resolvedPath: string) {
    const pendingOpen = rangeReadHandleOpens.get(resolvedPath);
    if (pendingOpen) {
        await pendingOpen
            .then(entry => requestRangeReadHandleClose(resolvedPath, entry))
            .catch(() => undefined);
    }

    const entry = rangeReadHandles.get(resolvedPath);
    if (!entry) {
        return;
    }
    await requestRangeReadHandleClose(resolvedPath, entry);
}

async function closeLeastRecentlyUsedRangeReadHandle() {
    const oldest = rangeReadHandles.entries().next();
    if (oldest.done) {
        return;
    }
    await requestRangeReadHandleClose(oldest.value[0], oldest.value[1]);
}

async function acquireRangeReadHandle(resolvedPath: string): Promise<IRangeReadHandleLease> {
    while (true) {
        const {
            mtimeMs,
            size,
        } = statSync(resolvedPath);
        const epoch = getRangeReadPathEpoch(resolvedPath);
        const cachedEntry = rangeReadHandles.get(resolvedPath);
        if (cachedEntry) {
            if (
                cachedEntry.size === size
                && cachedEntry.mtimeMs === mtimeMs
                && cachedEntry.epoch === epoch
                && !cachedEntry.closeRequested
                && !cachedEntry.closed
            ) {
                return acquireRangeReadHandleEntry(resolvedPath, cachedEntry);
            }
            await requestRangeReadHandleClose(resolvedPath, cachedEntry);
        }

        const pendingOpen = rangeReadHandleOpens.get(resolvedPath);
        if (pendingOpen) {
            const pendingEntry = await pendingOpen;
            if (
                rangeReadHandles.get(resolvedPath) === pendingEntry
                && pendingEntry.size === size
                && pendingEntry.mtimeMs === mtimeMs
                && pendingEntry.epoch === getRangeReadPathEpoch(resolvedPath)
                && !pendingEntry.closeRequested
                && !pendingEntry.closed
            ) {
                return acquireRangeReadHandleEntry(resolvedPath, pendingEntry);
            }
            await requestRangeReadHandleClose(resolvedPath, pendingEntry);
            continue;
        }

        while (rangeReadHandles.size >= RANGE_READ_HANDLE_CACHE_LIMIT) {
            await closeLeastRecentlyUsedRangeReadHandle();
        }

        const openPromise = (async () => {
            const handle = await openFileHandle(resolvedPath, 'r');
            const entry: IRangeReadHandleCacheEntry = {
                handle,
                mtimeMs,
                size,
                epoch,
                activeReads: 0,
                closeRequested: false,
                closed: false,
                closePromise: null,
                idleTimer: null,
            };
            if (epoch !== getRangeReadPathEpoch(resolvedPath)) {
                await requestRangeReadHandleClose(resolvedPath, entry);
                return entry;
            }

            rangeReadHandles.set(resolvedPath, entry);
            return entry;
        })();
        rangeReadHandleOpens.set(resolvedPath, openPromise);
        const entry = await openPromise.finally(() => {
            if (rangeReadHandleOpens.get(resolvedPath) === openPromise) {
                rangeReadHandleOpens.delete(resolvedPath);
            }
        });
        if (
            rangeReadHandles.get(resolvedPath) === entry
            && entry.epoch === getRangeReadPathEpoch(resolvedPath)
            && !entry.closeRequested
            && !entry.closed
        ) {
            return acquireRangeReadHandleEntry(resolvedPath, entry);
        }
        await requestRangeReadHandleClose(resolvedPath, entry);
    }
}

function acquireRangeReadHandleEntry(
    resolvedPath: string,
    entry: IRangeReadHandleCacheEntry,
): IRangeReadHandleLease {
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
    rangeReadHandles.delete(resolvedPath);
    rangeReadHandles.set(resolvedPath, entry);
    entry.activeReads += 1;
    let released = false;
    return {
        handle: entry.handle,
        async release() {
            if (released) {
                return;
            }
            released = true;
            entry.activeReads -= 1;
            if (entry.closeRequested) {
                await closeRangeReadHandleEntryWhenUnused(entry);
            } else {
                scheduleRangeReadHandleIdleClose(resolvedPath, entry);
            }
        },
    };
}

onWorkingCopyMutationSettled((workingCopyPath) => {
    advanceRangeReadPathEpoch(workingCopyPath);
    void closeCachedRangeReadHandle(workingCopyPath)
        .finally(() => pruneRangeReadPathEpochIfUnused(workingCopyPath));
});

export async function closeCachedRangeReadHandles() {
    await Promise.all(
        Array.from(rangeReadHandleOpens.entries(), async ([
            resolvedPath,
            pendingEntry,
        ]) => {
            advanceRangeReadPathEpoch(resolvedPath);
            return pendingEntry
                .then(entry => requestRangeReadHandleClose(resolvedPath, entry))
                .catch(() => undefined);
        }),
    );
    await Promise.all(
        Array.from(rangeReadHandles.entries(), async ([
            resolvedPath,
            entry,
        ]) => {
            advanceRangeReadPathEpoch(resolvedPath);
            return requestRangeReadHandleClose(resolvedPath, entry);
        }),
    );
    for (const resolvedPath of rangeReadPathEpochs.keys()) {
        pruneRangeReadPathEpochIfUnused(resolvedPath);
    }
}

export async function clearCachedRangeReadHandlesForTests() {
    await closeCachedRangeReadHandles();
    rangeReadPathEpochs.clear();
}

export function getRangeReadCacheStatsForTests() {
    return {
        handles: rangeReadHandles.size,
        pendingOpens: rangeReadHandleOpens.size,
        pathEpochs: rangeReadPathEpochs.size,
        pendingReads: pendingRangeReads.size,
        inFlightBytes: rangeReadGlobalBytes,
        budgetWaiters: rangeReadBudgetWaiters.length,
    };
}

export async function handleFileRead(context: IDocumentsSenderIdContext, filePath: unknown) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();

    if (!isAllowedBinaryReadExtension(extension)) {
        throw new Error('Invalid file type: only PDF and DjVu files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension, context.senderId);
    if (!resolvedPath) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    assertWithinIpcReadBudget(resolvedPath);
    const buffer = await readFile(resolvedPath);
    return new Uint8Array(buffer);
}

export async function handleFileStat(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<{ size: number }> {
    const resolvedPath = await resolveExistingReadableBinaryPath(filePath, context.senderId);
    const s = statSync(resolvedPath);
    return { size: s.size };
}

export async function handleFileReadRange(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    offset: unknown,
    length: unknown,
) {
    const resolvedPath = await resolveExistingReadableBinaryPath(filePath, context.senderId);
    const off = Number(offset);
    const len = Number(length);
    if (
        !Number.isSafeInteger(off)
        || !Number.isSafeInteger(len)
        || off < 0
        || len <= 0
    ) {
        throw new Error('Invalid range: offset must be >=0 and length must be >0');
    }

    const want = Math.min(len, MAX_CHUNK);

    const readKey = `${resolvedPath}\0${off}\0${want}\0${getRangeReadPathEpoch(resolvedPath)}`;
    const existingRead = pendingRangeReads.get(readKey);
    if (existingRead) {
        return existingRead;
    }

    const readPromise = (async () => {
        const releaseBudget = await acquireRangeReadBudget(resolvedPath, want);
        let lease: IRangeReadHandleLease | null = null;
        try {
            lease = await acquireRangeReadHandle(resolvedPath);
            const buf = Buffer.allocUnsafe(want);
            const { bytesRead } = await lease.handle.read(buf, 0, want, off);
            return new Uint8Array(buf.subarray(0, bytesRead));
        } finally {
            await lease?.release();
            releaseBudget();
        }
    })();
    pendingRangeReads.set(readKey, readPromise);
    return readPromise.finally(() => {
        if (pendingRangeReads.get(readKey) === readPromise) {
            pendingRangeReads.delete(readKey);
        }
    });
}

export async function handleFileReadText(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();

    if (!ALLOWED_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only .json, .txt, and .tsv files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension, context.senderId);
    if (!resolvedPath) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    assertWithinIpcReadBudget(resolvedPath);
    const buffer = await readFile(resolvedPath, 'utf-8');
    return buffer;
}

export function handleFileExists(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
) {
    if (typeof filePath !== 'string') {
        return false;
    }

    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
        return false;
    }

    const resolvedPath = resolveReadablePathSync(normalizedPath, context.senderId);
    if (!resolvedPath) {
        return false;
    }

    return true;
}
