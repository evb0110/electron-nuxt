import {
    open as openFileHandle,
    readFile,
    stat,
} from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { extname } from 'path';
import { MAX_CHUNK } from '@electron/config/constants';
import { onWorkingCopyMutationSettled } from '@electron/file-access/workingCopyMutationQueue';
import {
    captureWorkingCopyAdmissionSnapshot,
    getWorkingCopyBackingEntry,
    transitionWorkingCopyBackingState,
    workingCopyAdmissionSnapshotsMatch,
    type IWorkingCopyAdmissionSnapshot,
} from '@electron/file-access/workingCopyStore';
import {
    onWorkingCopyBackingSwapCacheInvalidation,
    WorkingCopyMaterializationError,
} from '@electron/file-access/workingCopyMaterialization';
import {
    assertWithinIpcReadBudget,
    describeRejectedReadPath,
    isAllowedBinaryReadExtension,
    normalizeNonEmptyPath,
    resolveExistingReadableDocumentOrImagePath,
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
const RANGE_READ_MAX_WAITERS = 256;
const RANGE_READ_WAITER_TIMEOUT_MS = 30_000;

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

interface IOriginalBackedRead {
    admissionSnapshot: IWorkingCopyAdmissionSnapshot;
    logicalRef: string;
    originalPath: string;
    registrationId: number;
    senderId?: number;
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
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
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
        clearTimeout(waiter.timer);
        reserveRangeRead(waiter.path, waiter.bytes);
        waiter.resolve();
    }
}

async function acquireRangeReadBudget(path: string, bytes: number) {
    if (!canReserveRangeRead(path, bytes)) {
        if (rangeReadBudgetWaiters.length >= RANGE_READ_MAX_WAITERS) {
            throw new Error('PDF range read queue is full; retry after active reads finish');
        }
        await new Promise<void>((resolve, reject) => {
            const waiter = {
                path,
                bytes,
                resolve,
                reject,
                timer: setTimeout(() => {
                    const index = rangeReadBudgetWaiters.indexOf(waiter);
                    if (index >= 0) {
                        rangeReadBudgetWaiters.splice(index, 1);
                    }
                    reject(new Error('Timed out waiting for PDF range read capacity'));
                }, RANGE_READ_WAITER_TIMEOUT_MS),
            };
            rangeReadBudgetWaiters.push(waiter);
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
        } = await stat(resolvedPath);
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

function createSourceBackingError(
    code: 'SOURCE_BACKING_CHANGED' | 'SOURCE_BACKING_UNAVAILABLE',
    cause?: unknown,
) {
    return new WorkingCopyMaterializationError(
        code,
        code === 'SOURCE_BACKING_CHANGED'
            ? 'The original document changed after it was opened'
            : 'The original document is unavailable',
        cause === undefined ? {} : {cause},
    );
}

function failOriginalBacking(
    backing: IOriginalBackedRead,
    code: 'SOURCE_BACKING_CHANGED' | 'SOURCE_BACKING_UNAVAILABLE',
    cause?: unknown,
): never {
    const entry = getWorkingCopyBackingEntry(backing.logicalRef, backing.senderId);
    if (entry?.registrationId === backing.registrationId) {
        transitionWorkingCopyBackingState(
            backing.logicalRef,
            backing.registrationId,
            'lazy-original',
            {
                expectedBackingState: [
                    'lazy-original',
                    'materializing',
                ],
                sourceBackingErrorCode: code,
            },
        );
    }
    throw createSourceBackingError(code, cause);
}

function resolveOriginalBackedRead(
    logicalRef: string,
    senderId?: number,
): IOriginalBackedRead | null {
    const entry = getWorkingCopyBackingEntry(logicalRef, senderId);
    if (
        !entry
        || (
            entry.backingState !== 'lazy-original'
            && entry.backingState !== 'materializing'
        )
    ) {
        return null;
    }
    if (
        entry.sourceBackingErrorCode === 'SOURCE_BACKING_CHANGED'
        || entry.sourceBackingErrorCode === 'SOURCE_BACKING_UNAVAILABLE'
    ) {
        throw createSourceBackingError(entry.sourceBackingErrorCode);
    }
    if (!entry.admissionSnapshot) {
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_MATERIALIZATION_FAILED',
            'Lazy working copy has no admission snapshot',
        );
    }
    return {
        admissionSnapshot: entry.admissionSnapshot,
        logicalRef,
        originalPath: entry.originalPath,
        registrationId: entry.registrationId,
        ...(senderId === undefined ? {} : {senderId}),
    };
}

export function resolveOriginalBackedReadTransport(
    logicalRef: string,
    senderId?: number,
) {
    const backing = resolveOriginalBackedRead(logicalRef, senderId);
    if (!backing) {
        return null;
    }
    return {
        identity: {
            size: Number(backing.admissionSnapshot.size),
            modifiedAt: Math.trunc(Number(backing.admissionSnapshot.mtimeNs) / 1_000_000),
        },
        read: async <T>(reader: (physicalPath: string) => Promise<T>) => {
            await assertOriginalBackingSnapshot(backing);
            try {
                return await reader(backing.originalPath);
            } finally {
                await assertOriginalBackingSnapshot(backing);
            }
        },
    };
}

async function assertOriginalBackingSnapshot(backing: IOriginalBackedRead) {
    let snapshot: IWorkingCopyAdmissionSnapshot;
    try {
        snapshot = await captureWorkingCopyAdmissionSnapshot(backing.originalPath);
    } catch (error) {
        failOriginalBacking(backing, 'SOURCE_BACKING_UNAVAILABLE', error);
    }
    if (!workingCopyAdmissionSnapshotsMatch(snapshot, backing.admissionSnapshot)) {
        failOriginalBacking(backing, 'SOURCE_BACKING_CHANGED');
    }
    const currentEntry = getWorkingCopyBackingEntry(backing.logicalRef, backing.senderId);
    if (!currentEntry || currentEntry.registrationId !== backing.registrationId) {
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_REGISTRATION_CHANGED',
            'Working-copy registration changed during the read',
        );
    }
    if (
        currentEntry.sourceBackingErrorCode === 'SOURCE_BACKING_CHANGED'
        || currentEntry.sourceBackingErrorCode === 'SOURCE_BACKING_UNAVAILABLE'
    ) {
        throw createSourceBackingError(currentEntry.sourceBackingErrorCode);
    }
    return snapshot;
}

// Original-backed reads share the rangeReadHandles cache keyed by the original
// path: the backing-swap invalidation event fires with that path, so a swap or
// materialization closes the cached handle. Every read runs the admission-
// snapshot assert both before and after the bytes are read: a same-size
// in-place rewrite during the read window would otherwise hand torn bytes to
// the renderer, and a short read whose snapshot still matches is a source
// anomaly that must fail rather than return a truncated document.
async function readOriginalBacking(
    backing: IOriginalBackedRead,
) {
    await assertOriginalBackingSnapshot(backing);
    const size = Number(backing.admissionSnapshot.size);
    assertWithinIpcReadBudget(backing.logicalRef, size);
    const buffer = Buffer.allocUnsafe(size);
    let totalBytesRead = 0;
    let lease: IRangeReadHandleLease | null = null;
    try {
        lease = await acquireRangeReadHandle(backing.originalPath);
        while (totalBytesRead < size) {
            const {bytesRead} = await lease.handle.read(
                buffer,
                totalBytesRead,
                size - totalBytesRead,
                totalBytesRead,
            );
            if (bytesRead <= 0) {
                break;
            }
            totalBytesRead += bytesRead;
        }
    } catch (error) {
        failOriginalBacking(backing, 'SOURCE_BACKING_UNAVAILABLE', error);
    } finally {
        await lease?.release();
    }
    await assertOriginalBackingSnapshot(backing);
    if (totalBytesRead !== size) {
        failOriginalBacking(backing, 'SOURCE_BACKING_UNAVAILABLE');
    }
    return new Uint8Array(buffer);
}

async function statOriginalBacking(backing: IOriginalBackedRead) {
    const snapshot = await assertOriginalBackingSnapshot(backing);
    return {
        size: Number(snapshot.size),
        modifiedAt: Math.trunc(Number(snapshot.mtimeNs) / 1_000_000),
    };
}

async function readOriginalBackingRange(
    backing: IOriginalBackedRead,
    offset: number,
    length: number,
) {
    await assertOriginalBackingSnapshot(backing);
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    let lease: IRangeReadHandleLease | null = null;
    try {
        lease = await acquireRangeReadHandle(backing.originalPath);
        ({bytesRead} = await lease.handle.read(buffer, 0, length, offset));
    } catch (error) {
        failOriginalBacking(backing, 'SOURCE_BACKING_UNAVAILABLE', error);
    } finally {
        await lease?.release();
    }
    if (bytesRead < length) {
        await assertOriginalBackingSnapshot(backing);
    }
    return new Uint8Array(buffer.subarray(0, bytesRead));
}

async function invalidateCachedRangeReadPath(resolvedPath: string) {
    advanceRangeReadPathEpoch(resolvedPath);
    await closeCachedRangeReadHandle(resolvedPath);
    pruneRangeReadPathEpochIfUnused(resolvedPath);
}

onWorkingCopyMutationSettled((workingCopyPath) => {
    advanceRangeReadPathEpoch(workingCopyPath);
    void closeCachedRangeReadHandle(workingCopyPath)
        .finally(() => pruneRangeReadPathEpochIfUnused(workingCopyPath));
});

onWorkingCopyBackingSwapCacheInvalidation(async (logicalRef, previousPhysicalPath) => {
    await Promise.all(
        [...new Set([
            logicalRef,
            previousPhysicalPath,
        ])].map(invalidateCachedRangeReadPath),
    );
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
        throw new Error('Invalid file type: only supported document and image files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension, context.senderId);
    if (!resolvedPath) {
        throw new Error(describeRejectedReadPath(normalizedPath, context.senderId));
    }

    const originalBacking = resolveOriginalBackedRead(resolvedPath, context.senderId);
    if (originalBacking) {
        return readOriginalBacking(originalBacking);
    }

    let size: number;
    try {
        ({size} = await stat(resolvedPath));
    } catch {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    assertWithinIpcReadBudget(resolvedPath, size);
    const buffer = await readFile(resolvedPath);
    return new Uint8Array(buffer);
}

export async function handleFileStat(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<{
    size: number;
    modifiedAt: number
}> {
    const resolvedPath = await resolveExistingReadableDocumentOrImagePath(filePath, context.senderId);
    const originalBacking = resolveOriginalBackedRead(resolvedPath, context.senderId);
    if (originalBacking) {
        return statOriginalBacking(originalBacking);
    }
    const s = await stat(resolvedPath);
    return {
        size: s.size,
        modifiedAt: Math.trunc(s.mtimeMs),
    };
}

export async function handleFileReadRange(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    offset: unknown,
    length: unknown,
) {
    const resolvedPath = await resolveExistingReadableDocumentOrImagePath(filePath, context.senderId);
    const originalBacking = resolveOriginalBackedRead(resolvedPath, context.senderId);
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

    const readKey = `${resolvedPath}\0${originalBacking?.registrationId ?? 'managed'}\0${off}\0${want}\0${getRangeReadPathEpoch(resolvedPath)}`;
    const existingRead = pendingRangeReads.get(readKey);
    if (existingRead) {
        return existingRead;
    }

    const readPromise = (async () => {
        const releaseBudget = await acquireRangeReadBudget(resolvedPath, want);
        let lease: IRangeReadHandleLease | null = null;
        try {
            if (originalBacking) {
                return await readOriginalBackingRange(originalBacking, off, want);
            }
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
        throw new Error(describeRejectedReadPath(normalizedPath, context.senderId));
    }

    let size: number;
    try {
        ({size} = await stat(resolvedPath));
    } catch {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    assertWithinIpcReadBudget(resolvedPath, size);
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
