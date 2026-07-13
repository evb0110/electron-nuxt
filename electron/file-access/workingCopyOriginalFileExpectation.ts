import { createHash } from 'crypto';
import {
    closeSync,
    openSync,
    readSync,
} from 'fs';
import { open } from 'fs/promises';
import {abortErrorFromSignal} from '@electron/utils/abort';

const ORIGINAL_FILE_FINGERPRINT_CHUNK_BYTES = 1024 * 1024;
const ORIGINAL_FILE_FINGERPRINT_VERSION = 'sha256-full-v1';

function createFingerprintHash(size: number) {
    const hash = createHash('sha256');
    hash.update(`${ORIGINAL_FILE_FINGERPRINT_VERSION}\nsize:${size}\n`);
    return hash;
}

export function createOriginalFileContentFingerprintSync(filePath: string, size: number) {
    const hash = createFingerprintHash(size);
    const fd = openSync(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(Math.min(ORIGINAL_FILE_FINGERPRINT_CHUNK_BYTES, Math.max(size, 1)));
        let offset = 0;
        while (offset < size) {
            const length = Math.min(buffer.byteLength, size - offset);
            const bytesRead = readSync(fd, buffer, 0, length, offset);
            if (bytesRead !== length) {
                return undefined;
            }
            hash.update(buffer.subarray(0, length));
            offset += length;
        }
        return `${ORIGINAL_FILE_FINGERPRINT_VERSION}:${hash.digest('hex')}`;
    } finally {
        closeSync(fd);
    }
}

export async function createOriginalFileContentFingerprint(
    filePath: string,
    size: number,
    signal?: AbortSignal,
) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
    const hash = createFingerprintHash(size);
    const handle = await open(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(Math.min(ORIGINAL_FILE_FINGERPRINT_CHUNK_BYTES, Math.max(size, 1)));
        let offset = 0;
        while (offset < size) {
            if (signal?.aborted) {
                throw abortErrorFromSignal(signal);
            }
            const length = Math.min(buffer.byteLength, size - offset);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            if (signal?.aborted) {
                throw abortErrorFromSignal(signal);
            }
            if (bytesRead !== length) {
                return undefined;
            }
            hash.update(buffer.subarray(0, length));
            offset += length;
        }
        return `${ORIGINAL_FILE_FINGERPRINT_VERSION}:${hash.digest('hex')}`;
    } finally {
        await handle.close().catch(() => undefined);
    }
}
