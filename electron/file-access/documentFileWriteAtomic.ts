import {
    lstatSync,
    realpathSync,
} from 'fs';
import {
    copyFile,
    open as openFileHandle,
    rename,
    unlink,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
    resolve,
} from 'path';
import { randomUUID } from 'crypto';
import { isErrnoException } from '@contracts/runtimeGuards';
import {syncFileHandleForDurability} from '@electron/utils/syncFileHandleForDurability';

const MAX_IPC_WRITE_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_MAX_IPC_WRITE_BYTES ?? `${16 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1024) {
        return 16 * 1024 * 1024;
    }
    return parsed;
})();
const ALLOWED_SYSTEM_SYMLINK_TARGETS = new Map([
    [
        '/tmp',
        '/private/tmp',
    ],
    [
        '/var',
        '/private/var',
    ],
]);

function assertWithinIpcWriteBudget(byteLength: number) {
    if (byteLength > MAX_IPC_WRITE_BYTES) {
        throw new Error(`Invalid data: exceeds max size (${MAX_IPC_WRITE_BYTES} bytes)`);
    }
}

export function normalizeIpcWritePayload(data: unknown) {
    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }
    assertWithinIpcWriteBudget(data.byteLength);
    return data;
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
                if (isAllowedSystemSymlinkPathSegment(segment)) {
                    continue;
                }
                throw new Error(`Invalid file path: symlink path segment is not allowed (${segment})`);
            }
        } catch (error) {
            const code = isErrnoException(error) ? error.code : undefined;
            if (code === 'ENOENT') {
                continue;
            }
            throw error;
        }
    }
}

function isAllowedSystemSymlinkPathSegment(segment: string) {
    const allowedTarget = ALLOWED_SYSTEM_SYMLINK_TARGETS.get(segment);
    if (!allowedTarget) {
        return false;
    }

    try {
        return realpathSync(segment) === allowedTarget;
    } catch {
        return false;
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

export async function writeFileAtomic(resolvedPath: string, payload: Uint8Array) {
    assertNoSymlinkPathSegments(resolvedPath);

    const directoryPath = dirname(resolvedPath);
    const temporaryPath = join(
        directoryPath,
        `.${basename(resolvedPath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    const handle = await openFileHandle(temporaryPath, 'wx');
    try {
        await handle.writeFile(payload);
        await syncFileHandleForDurability(handle);
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

export async function copyFileAtomic(resolvedSourcePath: string, resolvedTargetPath: string) {
    assertNoSymlinkPathSegments(resolvedSourcePath);
    assertNoSymlinkPathSegments(resolvedTargetPath);

    const directoryPath = dirname(resolvedTargetPath);
    const temporaryPath = join(
        directoryPath,
        `.${basename(resolvedTargetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
        await copyFile(resolvedSourcePath, temporaryPath);
        const handle = await openFileHandle(temporaryPath, 'r');
        try {
            await syncFileHandleForDurability(handle);
        } finally {
            await handle.close().catch(() => undefined);
        }
        assertNoSymlinkPathSegments(resolvedTargetPath);
        await rename(temporaryPath, resolvedTargetPath);
        await fsyncDirectoryBestEffort(directoryPath);
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}
