import {
    existsSync,
    statSync,
} from 'fs';
import {
    open as openFileHandle,
    readFile,
} from 'fs/promises';
import { extname } from 'path';
import { MAX_CHUNK } from '@electron/config/constants';
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

export async function handleFileRead(event: Electron.IpcMainInvokeEvent, filePath: unknown): Promise<Uint8Array> {
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
): Promise<Uint8Array> {
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

    const fh = await openFileHandle(resolvedPath, 'r');
    try {
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fh.read(buf, 0, want, off);
        return new Uint8Array(buf.subarray(0, bytesRead));
    } finally {
        await fh.close();
    }
}

export async function handleFileReadText(
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): Promise<string> {
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
): boolean {
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
