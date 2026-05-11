import {
    existsSync,
    lstatSync,
    realpathSync,
    statSync,
} from 'fs';
import {
    readFile,
    writeFile,
    unlink,
    rename,
    open as openFileHandle,
} from 'fs/promises';
import {
    extname,
    basename,
    resolve,
    dirname,
    join,
} from 'path';
import { randomUUID } from 'crypto';
import {
    isAllowedReadPath,
    resolveAllowedReadPath,
    resolveAllowedWritePath,
} from '@electron/utils/path-validator';
import {
    ensureWorkingCopyDirectory,
    findWorkingCopyPathByOriginalPath,
} from '@electron/ipc/workingCopy';
import { isAllowedDjvuViewingPath } from '@electron/djvu/viewing';
import { consumeAllowedDocxWritePath } from '@electron/ipc/docxExportPaths';
import { MAX_CHUNK } from '@electron/config/constants';
import { createLogger } from '@electron/utils/logger';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdf-conformance';
import {
    analyzePdfConformanceFile,
    validatePdfData as validatePdfBytes,
} from '@electron/features/documents/main/pdf-conformance';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('documents-file-ops');
const MAX_IPC_READ_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_MAX_IPC_READ_BYTES ?? `${512 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1024) {
        return 512 * 1024 * 1024;
    }
    return parsed;
})();
const MAX_IPC_WRITE_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_MAX_IPC_WRITE_BYTES ?? `${512 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1024) {
        return 512 * 1024 * 1024;
    }
    return parsed;
})();

const ALLOWED_READ_EXTENSIONS = new Set([
    '.json',
    '.txt',
    '.tsv',
]);

const ALLOWED_BINARY_READ_EXTENSIONS = new Set([
    '.pdf',
    '.djvu',
    '.djv',
]);
const ALLOWED_DIRECT_SOURCE_READ_EXTENSIONS = new Set([
    '.djvu',
    '.djv',
]);

function normalizeNonEmptyPath(filePath: unknown): string {
    if (typeof filePath !== 'string') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
        throw new Error('Invalid file path: path must be a non-empty string');
    }
    return normalizedPath;
}

function resolveDirectSourceReadPath(
    normalizedPath: string,
    extension: string,
    senderId?: number,
): string | null {
    if (!ALLOWED_DIRECT_SOURCE_READ_EXTENSIONS.has(extension)) {
        return null;
    }

    const isDirectReadAllowed = typeof senderId === 'number'
        ? isAllowedDjvuViewingPath(normalizedPath, senderId)
        : isAllowedDjvuViewingPath(normalizedPath);
    if (!isDirectReadAllowed) {
        return null;
    }

    const absolutePath = resolve(normalizedPath);
    if (!existsSync(absolutePath)) {
        return null;
    }

    try {
        if (lstatSync(absolutePath).isSymbolicLink()) {
            return null;
        }

        return realpathSync(absolutePath);
    } catch {
        return null;
    }
}

async function resolveReadablePath(
    normalizedPath: string,
    extension: string,
    senderId?: number,
): Promise<string | null> {
    const directResolvedPath = await resolveAllowedReadPath(normalizedPath);
    if (directResolvedPath) {
        return directResolvedPath;
    }

    // When renderer still references the original path, remap it to the active
    // working copy path to preserve temp-sandboxed reads.
    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath);
    if (!mappedWorkingCopyPath) {
        return resolveDirectSourceReadPath(normalizedPath, extension, senderId);
    }

    const mappedResolvedPath = await resolveAllowedReadPath(mappedWorkingCopyPath);
    if (mappedResolvedPath) {
        return mappedResolvedPath;
    }

    return resolveDirectSourceReadPath(normalizedPath, extension, senderId);
}

async function resolveExistingReadableBinaryPath(
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();
    if (!ALLOWED_BINARY_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only PDF and DjVu files are allowed');
    }

    const resolvedPath = await resolveReadablePath(
        normalizedPath,
        extension,
        event.sender?.id,
    );
    if (!resolvedPath) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    return resolvedPath;
}

async function resolveExistingReadablePdfPath(filePath: unknown) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension);
    if (!resolvedPath) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    return resolvedPath;
}

function resolveReadablePathSync(normalizedPath: string): string | null {
    if (isAllowedReadPath(normalizedPath) && existsSync(normalizedPath)) {
        return normalizedPath;
    }

    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath);
    if (!mappedWorkingCopyPath) {
        return null;
    }

    if (!isAllowedReadPath(mappedWorkingCopyPath) || !existsSync(mappedWorkingCopyPath)) {
        return null;
    }

    return mappedWorkingCopyPath;
}

function normalizeIpcWritePayload(data: unknown) {
    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }
    if (data.byteLength > MAX_IPC_WRITE_BYTES) {
        throw new Error(`Invalid data: exceeds max size (${MAX_IPC_WRITE_BYTES} bytes)`);
    }
    return data;
}

function assertWithinIpcReadBudget(resolvedPath: string) {
    const { size } = statSync(resolvedPath);
    if (size > MAX_IPC_READ_BYTES) {
        throw new Error(`Invalid file: exceeds max IPC read size (${MAX_IPC_READ_BYTES} bytes); use range reads`);
    }
}

function assertNoSymlinkPathSegments(resolvedPath: string) {
    const segments: string[] = [];
    let currentPath = resolve(resolvedPath);

    while (true) {
        segments.push(currentPath);
        const parentPath = dirname(currentPath);
        if (parentPath === currentPath) {
            break;
        }
        currentPath = parentPath;
    }

    for (const segment of segments) {
        try {
            if (lstatSync(segment).isSymbolicLink()) {
                throw new Error(`Invalid file path: symlink path segment is not allowed (${segment})`);
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code;
            if (code === 'ENOENT') {
                continue;
            }
            throw error;
        }
    }
}

async function fsyncDirectoryBestEffort(directoryPath: string) {
    let directoryHandle;
    try {
        directoryHandle = await openFileHandle(directoryPath, 'r');
        await directoryHandle.sync();
    } catch {
        // Some platforms do not allow opening directories for fsync.
    } finally {
        await directoryHandle?.close().catch(() => undefined);
    }
}

async function writeFileAtomic(resolvedPath: string, payload: Uint8Array) {
    assertNoSymlinkPathSegments(resolvedPath);

    const directoryPath = dirname(resolvedPath);
    const temporaryPath = join(
        directoryPath,
        `.${basename(resolvedPath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    const handle = await openFileHandle(temporaryPath, 'wx');
    try {
        await handle.writeFile(payload);
        await handle.sync();
    } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }

    await handle.close();
    try {
        assertNoSymlinkPathSegments(resolvedPath);
        await rename(temporaryPath, resolvedPath);
        await fsyncDirectoryBestEffort(directoryPath);
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

export async function handleFileRead(event: Electron.IpcMainInvokeEvent, filePath: unknown): Promise<Uint8Array> {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();
    const senderId = event.sender?.id;

    if (!ALLOWED_BINARY_READ_EXTENSIONS.has(extension)) {
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

export async function handleFileWrite(
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
    data: unknown,
): Promise<boolean> {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    await ensureWorkingCopyDirectory(resolvedPath);
    try {
        await writeFileAtomic(resolvedPath, payload);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            throw error;
        }
        await ensureWorkingCopyDirectory(resolvedPath);
        await writeFileAtomic(resolvedPath, payload);
    }
    return true;
}

export async function handleFileWriteDocx(
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
    data: unknown,
): Promise<boolean> {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    if (!consumeAllowedDocxWritePath(normalizedPath)) {
        throw new Error('Invalid file path: DOCX writes must use a path from Save dialog');
    }

    await writeFile(resolve(normalizedPath), payload);
    return true;
}

export async function handleFileReadText(
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): Promise<string> {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();

    if (!ALLOWED_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only .json, .txt, and .tsv files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension);
    if (!resolvedPath) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    const buffer = await readFile(resolvedPath, 'utf-8');
    return buffer;
}

export function handleFileExists(
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): boolean {
    if (typeof filePath !== 'string') {
        return false;
    }

    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
        return false;
    }

    const resolvedPath = resolveReadablePathSync(normalizedPath);
    if (!resolvedPath) {
        return false;
    }

    return true;
}

export async function handleAnalyzePdfConformance(
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): Promise<IPdfConformanceProfile> {
    const resolvedPath = await resolveExistingReadablePdfPath(filePath);
    return analyzePdfConformanceFile(resolvedPath);
}

export async function handleValidatePdfData(
    _event: Electron.IpcMainInvokeEvent,
    data: unknown,
    fileName?: unknown,
): Promise<IPdfValidationResult> {
    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }
    if (typeof fileName !== 'undefined' && typeof fileName !== 'string') {
        throw new Error('Invalid file name: must be a string');
    }

    return validatePdfBytes(data, fileName);
}

export async function handleCleanupOcrTemp(
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
) {
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    try {
        const resolvedPath = await resolveAllowedWritePath(normalizedPath);
        if (!resolvedPath) {
            return;
        }

        const fileName = basename(resolvedPath);
        const isOcrArtifact = fileName.startsWith('ocr-') || fileName.startsWith('searchable-');

        if (!isOcrArtifact) {
            return;
        }

        try {
            await unlink(resolvedPath);
        } catch (unlinkErr) {
            const code = (unlinkErr as NodeJS.ErrnoException | null)?.code;
            if (code !== 'ENOENT') {
                throw unlinkErr;
            }
        }
    } catch (err) {
        logger.warn(`Failed to delete OCR temp file: ${getErrorMessage(err)}`);
    }
}
