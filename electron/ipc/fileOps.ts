import { existsSync } from 'fs';
import {
    readFile,
    writeFile,
    stat,
    unlink,
    open as openFileHandle,
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
import { consumeAllowedDocxWritePath } from '@electron/ipc/docxExportPaths';
import { MAX_CHUNK } from '@electron/config/constants';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('file-ops');

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

async function resolveReadablePath(normalizedPath: string): Promise<string | null> {
    const directResolvedPath = await resolveAllowedReadPath(normalizedPath);
    if (directResolvedPath) {
        return directResolvedPath;
    }

    // When renderer still references the original path, remap it to the active
    // working copy path to preserve temp-sandboxed reads.
    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath);
    if (!mappedWorkingCopyPath) {
        return null;
    }

    return resolveAllowedReadPath(mappedWorkingCopyPath);
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

export async function handleFileRead(_event: Electron.IpcMainInvokeEvent, filePath: string): Promise<Uint8Array> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();

    if (!ALLOWED_BINARY_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only PDF and DjVu files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath);
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
    filePath: string,
): Promise<{ size: number }> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath);
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
    filePath: string,
    offset: number,
    length: number,
): Promise<Uint8Array> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }
    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    const off = Number(offset);
    const len = Number(length);
    if (!Number.isFinite(off) || !Number.isFinite(len) || off < 0 || len <= 0) {
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
    filePath: string,
    data: Uint8Array,
): Promise<boolean> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }

    const normalizedPath = filePath.trim();

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    await writeFile(resolvedPath, data);
    return true;
}

export async function handleFileWriteDocx(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
    data: Uint8Array,
): Promise<boolean> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }

    const normalizedPath = filePath.trim();
    if (!consumeAllowedDocxWritePath(normalizedPath)) {
        throw new Error('Invalid file path: DOCX writes must use a path from Save dialog');
    }

    await writeFile(resolve(normalizedPath), data);
    return true;
}

export async function handleFileReadText(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
): Promise<string> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();

    if (!ALLOWED_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only .json, .txt, and .tsv files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath);
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
    filePath: string,
): boolean {
    if (!filePath || filePath.trim() === '') {
        return false;
    }

    const normalizedPath = filePath.trim();

    const resolvedPath = resolveReadablePathSync(normalizedPath);
    if (!resolvedPath) {
        return false;
    }

    return true;
}

export async function handleCleanupOcrTemp(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
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
