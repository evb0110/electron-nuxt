import { existsSync } from 'fs';
import {
    readFile,
    writeFile,
    stat,
    unlink,
    open as openFileHandle,
    lstat,
    realpath,
} from 'fs/promises';
import {
    extname,
    basename,
    resolve,
} from 'path';
import {
    isAllowedReadPath,
    resolveAllowedReadPath,
    resolveAllowedWritePath,
} from '@electron/utils/path-validator';
import { findWorkingCopyPathByOriginalPath } from '@electron/ipc/workingCopy';
import { isAllowedDjvuViewingPath } from '@electron/features/djvu/main/viewing';
import { consumeAllowedDocxWritePath } from '@electron/ipc/docxExportPaths';
import { MAX_CHUNK } from '@electron/config/constants';
import { createLogger } from '@electron/utils/logger';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/electron-api';
import {
    analyzePdfConformanceData,
    validatePdfData as validatePdfBytes,
} from '@electron/features/documents/main/pdf-conformance';

const logger = createLogger('documents-file-ops');
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

async function resolveDirectSourceReadPath(
    normalizedPath: string,
    extension: string,
): Promise<string | null> {
    if (!ALLOWED_DIRECT_SOURCE_READ_EXTENSIONS.has(extension)) {
        return null;
    }

    if (!isAllowedDjvuViewingPath(normalizedPath)) {
        return null;
    }

    const absolutePath = resolve(normalizedPath);
    if (!existsSync(absolutePath)) {
        return null;
    }

    try {
        const pathStat = await lstat(absolutePath);
        if (pathStat.isSymbolicLink()) {
            return null;
        }

        return await realpath(absolutePath);
    } catch {
        return null;
    }
}

async function resolveReadablePath(
    normalizedPath: string,
    extension: string,
): Promise<string | null> {
    const directResolvedPath = await resolveAllowedReadPath(normalizedPath);
    if (directResolvedPath) {
        return directResolvedPath;
    }

    // When renderer still references the original path, remap it to the active
    // working copy path to preserve temp-sandboxed reads.
    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath);
    if (!mappedWorkingCopyPath) {
        return resolveDirectSourceReadPath(normalizedPath, extension);
    }

    const mappedResolvedPath = await resolveAllowedReadPath(mappedWorkingCopyPath);
    if (mappedResolvedPath) {
        return mappedResolvedPath;
    }

    return resolveDirectSourceReadPath(normalizedPath, extension);
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

export async function handleFileRead(_event: Electron.IpcMainInvokeEvent, filePath: unknown): Promise<Uint8Array> {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();

    if (!ALLOWED_BINARY_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only PDF and DjVu files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension);
    if (!resolvedPath) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    const buffer = await readFile(resolvedPath);
    return new Uint8Array(buffer);
}

export async function handleFileStat(
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): Promise<{ size: number }> {
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

    const s = await stat(resolvedPath);
    return { size: s.size };
}

export async function handleFileReadRange(
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
    offset: unknown,
    length: unknown,
): Promise<Uint8Array> {
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
    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }
    if (data.byteLength > MAX_IPC_WRITE_BYTES) {
        throw new Error(`Invalid data: exceeds max size (${MAX_IPC_WRITE_BYTES} bytes)`);
    }

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    await writeFile(resolvedPath, data);
    return true;
}

export async function handleFileWriteDocx(
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
    data: unknown,
): Promise<boolean> {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }
    if (data.byteLength > MAX_IPC_WRITE_BYTES) {
        throw new Error(`Invalid data: exceeds max size (${MAX_IPC_WRITE_BYTES} bytes)`);
    }
    if (!consumeAllowedDocxWritePath(normalizedPath)) {
        throw new Error('Invalid file path: DOCX writes must use a path from Save dialog');
    }

    await writeFile(resolve(normalizedPath), data);
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
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): Promise<IPdfConformanceProfile> {
    const data = await handleFileRead(event, filePath);
    return analyzePdfConformanceData(data);
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

        if (existsSync(resolvedPath)) {
            await unlink(resolvedPath);
        }
    } catch (err) {
        logger.warn(`Failed to delete OCR temp file: ${err instanceof Error ? err.message : String(err)}`);
    }
}
