import {
    existsSync,
    lstatSync,
    realpathSync,
    statSync,
} from 'fs';
import {
    extname,
    resolve,
} from 'path';
import {
    isAllowedReadPath,
    resolveAllowedReadPath,
} from '@electron/utils/pathValidator';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import { findWorkingCopyPathByOriginalPath } from '@electron/file-access/workingCopyStore';
import { isAllowedDjvuViewingPath } from '@electron/djvu/viewing';

const MAX_IPC_READ_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_MAX_IPC_READ_BYTES ?? `${16 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1024) {
        return 16 * 1024 * 1024;
    }
    return parsed;
})();
const ALLOWED_BINARY_READ_EXTENSIONS = new Set([
    '.pdf',
    '.djvu',
    '.djv',
]);
const ALLOWED_DIRECT_SOURCE_READ_EXTENSIONS = new Set([
    '.djvu',
    '.djv',
]);

export function normalizeNonEmptyPath(filePath: unknown) {
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
) {
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

export async function resolveReadablePath(
    normalizedPath: string,
    extension: string,
    senderId?: number,
) {
    const directResolvedPath = await resolveAllowedReadPath(normalizedPath);
    if (directResolvedPath) {
        return directResolvedPath;
    }

    if (await ensureWorkingCopyDirectory(normalizedPath, senderId)) {
        const restoredWorkingCopyPath = await resolveAllowedReadPath(normalizedPath);
        if (restoredWorkingCopyPath) {
            return restoredWorkingCopyPath;
        }
    }

    // When renderer still references the original path, remap it to the active
    // working copy path to preserve temp-sandboxed reads.
    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath, senderId);
    if (!mappedWorkingCopyPath) {
        return resolveDirectSourceReadPath(normalizedPath, extension, senderId);
    }

    const mappedResolvedPath = await resolveAllowedReadPath(mappedWorkingCopyPath);
    if (mappedResolvedPath) {
        return mappedResolvedPath;
    }

    return resolveDirectSourceReadPath(normalizedPath, extension, senderId);
}

export async function resolveExistingReadableBinaryPath(
    filePath: unknown,
    senderId?: number,
) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();
    if (!ALLOWED_BINARY_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only PDF and DjVu files are allowed');
    }

    const resolvedPath = await resolveReadablePath(
        normalizedPath,
        extension,
        senderId,
    );
    if (!resolvedPath) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    return resolvedPath;
}

export async function resolveExistingReadablePdfPath(filePath: unknown, senderId?: number) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension, senderId);
    if (!resolvedPath) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    return resolvedPath;
}

export function resolveReadablePathSync(normalizedPath: string, senderId?: number) {
    if (isAllowedReadPath(normalizedPath) && existsSync(normalizedPath)) {
        return normalizedPath;
    }

    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath, senderId);
    if (!mappedWorkingCopyPath) {
        return null;
    }

    if (!isAllowedReadPath(mappedWorkingCopyPath) || !existsSync(mappedWorkingCopyPath)) {
        return null;
    }

    return mappedWorkingCopyPath;
}

export function assertWithinIpcReadBudget(resolvedPath: string) {
    const { size } = statSync(resolvedPath);
    if (size > MAX_IPC_READ_BYTES) {
        throw new Error(`Invalid file: exceeds max IPC read size (${MAX_IPC_READ_BYTES} bytes); use range reads`);
    }
}

export function isAllowedBinaryReadExtension(extension: string) {
    return ALLOWED_BINARY_READ_EXTENSIONS.has(extension);
}
