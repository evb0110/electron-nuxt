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

const ALLOWED_READ_EXTENSIONS = new Set([
    '.json',
    '.txt',
    '.tsv',
]);
const RANGE_READ_HANDLE_CACHE_LIMIT = 6;
const RANGE_READ_HANDLE_IDLE_MS = 30_000;

interface IRangeReadHandleCacheEntry {
    handle: FileHandle;
    mtimeMs: number;
    size: number;
    idleTimer: ReturnType<typeof setTimeout> | null;
}

const rangeReadHandles = new Map<string, IRangeReadHandleCacheEntry>();

function scheduleRangeReadHandleIdleClose(
    resolvedPath: string,
    entry: IRangeReadHandleCacheEntry,
) {
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
    }
    entry.idleTimer = setTimeout(() => {
        const currentEntry = rangeReadHandles.get(resolvedPath);
        if (currentEntry !== entry) {
            return;
        }
        rangeReadHandles.delete(resolvedPath);
        void entry.handle.close().catch(() => undefined);
    }, RANGE_READ_HANDLE_IDLE_MS);
    (entry.idleTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

async function closeRangeReadHandleEntry(
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
    await entry.handle.close().catch(() => undefined);
}

async function closeCachedRangeReadHandle(resolvedPath: string) {
    const entry = rangeReadHandles.get(resolvedPath);
    if (!entry) {
        return;
    }
    await closeRangeReadHandleEntry(resolvedPath, entry);
}

async function closeLeastRecentlyUsedRangeReadHandle() {
    const oldest = rangeReadHandles.entries().next();
    if (oldest.done) {
        return;
    }
    await closeRangeReadHandleEntry(oldest.value[0], oldest.value[1]);
}

async function getRangeReadHandle(resolvedPath: string) {
    const {
        mtimeMs,
        size,
    } = statSync(resolvedPath);
    const cachedEntry = rangeReadHandles.get(resolvedPath);
    if (cachedEntry) {
        if (cachedEntry.size === size && cachedEntry.mtimeMs === mtimeMs) {
            rangeReadHandles.delete(resolvedPath);
            rangeReadHandles.set(resolvedPath, cachedEntry);
            scheduleRangeReadHandleIdleClose(resolvedPath, cachedEntry);
            return cachedEntry.handle;
        }
        await closeRangeReadHandleEntry(resolvedPath, cachedEntry);
    }

    while (rangeReadHandles.size >= RANGE_READ_HANDLE_CACHE_LIMIT) {
        await closeLeastRecentlyUsedRangeReadHandle();
    }

    const handle = await openFileHandle(resolvedPath, 'r');
    const entry: IRangeReadHandleCacheEntry = {
        handle,
        mtimeMs,
        size,
        idleTimer: null,
    };
    rangeReadHandles.set(resolvedPath, entry);
    scheduleRangeReadHandleIdleClose(resolvedPath, entry);
    return handle;
}

onWorkingCopyMutationSettled((workingCopyPath) => {
    void closeCachedRangeReadHandle(workingCopyPath);
});

export async function clearCachedRangeReadHandlesForTests() {
    await Promise.all(
        Array.from(rangeReadHandles.entries(), async ([
            resolvedPath,
            entry,
        ]) => closeRangeReadHandleEntry(resolvedPath, entry)),
    );
}

export async function handleFileRead(event: Electron.IpcMainInvokeEvent, filePath: unknown) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();
    const senderId = event.sender?.id;

    if (!isAllowedBinaryReadExtension(extension)) {
        throw new Error('Invalid file type: only PDF and DjVu files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension, senderId);
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
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): Promise<{ size: number }> {
    const resolvedPath = await resolveExistingReadableBinaryPath(event, filePath);
    const s = statSync(resolvedPath);
    return { size: s.size };
}

export async function handleFileReadRange(
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
    offset: unknown,
    length: unknown,
) {
    const resolvedPath = await resolveExistingReadableBinaryPath(event, filePath);
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

    const fh = await getRangeReadHandle(resolvedPath);
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await fh.read(buf, 0, want, off);
    return new Uint8Array(buf.subarray(0, bytesRead));
}

export async function handleFileReadText(
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();

    if (!ALLOWED_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only .json, .txt, and .tsv files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension, event.sender?.id);
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
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
) {
    if (typeof filePath !== 'string') {
        return false;
    }

    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
        return false;
    }

    const resolvedPath = resolveReadablePathSync(normalizedPath, event.sender?.id);
    if (!resolvedPath) {
        return false;
    }

    return true;
}
