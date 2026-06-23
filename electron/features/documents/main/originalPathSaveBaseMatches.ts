import {
    open,
    stat,
} from 'fs/promises';
import { getWorkingCopyOriginalFileExpectation } from '@electron/file-access/workingCopyStore';
import { createOriginalFileContentFingerprint } from '@electron/file-access/workingCopyOriginalFileExpectation';

const SAVE_BASE_COMPARE_CHUNK_BYTES = 1024 * 1024;

async function originalPathMatchesStoredExpectation(
    originalPath: string,
    expectedOriginal: NonNullable<ReturnType<typeof getWorkingCopyOriginalFileExpectation>>,
) {
    if (!expectedOriginal.contentFingerprint) {
        return null;
    }
    const originalStat = await stat(originalPath);
    if (originalStat.size !== expectedOriginal.size) {
        return false;
    }
    return await createOriginalFileContentFingerprint(originalPath, originalStat.size)
        === expectedOriginal.contentFingerprint;
}

function yieldBetweenCompareChunks() {
    return new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
}

async function compareFilesByChunk(originalPath: string, workingPath: string, size: number) {
    const originalHandle = await open(originalPath, 'r');
    let workingHandle: Awaited<ReturnType<typeof open>> | null = null;

    try {
        workingHandle = await open(workingPath, 'r');
        const originalBuffer = Buffer.allocUnsafe(Math.min(SAVE_BASE_COMPARE_CHUNK_BYTES, size));
        const workingBuffer = Buffer.allocUnsafe(originalBuffer.byteLength);
        let offset = 0;

        while (offset < size) {
            const length = Math.min(originalBuffer.byteLength, size - offset);
            const [
                originalRead,
                workingRead,
            ] = await Promise.all([
                originalHandle.read(originalBuffer, 0, length, offset),
                workingHandle.read(workingBuffer, 0, length, offset),
            ]);

            if (
                originalRead.bytesRead !== length
                || workingRead.bytesRead !== length
                || Buffer.compare(
                    originalBuffer.subarray(0, length),
                    workingBuffer.subarray(0, length),
                ) !== 0
            ) {
                return false;
            }

            offset += length;
            if (offset < size) {
                await yieldBetweenCompareChunks();
            }
        }

        return true;
    } finally {
        await Promise.all([
            originalHandle.close().catch(() => undefined),
            workingHandle?.close().catch(() => undefined),
        ]);
    }
}

async function originalPathMatchesWorkingCopyBytes(
    originalPath: string,
    workingPath: string,
) {
    const [
        originalStat,
        workingStat,
    ] = await Promise.all([
        stat(originalPath),
        stat(workingPath),
    ]);
    if (originalStat.size !== workingStat.size) {
        return false;
    }

    return compareFilesByChunk(originalPath, workingPath, originalStat.size);
}

export async function originalPathSaveBaseMatches(
    workingPath: string,
    originalPath: string,
    senderWebContentsId: number,
) {
    const expectedOriginal = getWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId);
    if (!expectedOriginal) {
        return originalPathMatchesWorkingCopyBytes(originalPath, workingPath);
    }
    const storedExpectationMatches = await originalPathMatchesStoredExpectation(originalPath, expectedOriginal);
    if (storedExpectationMatches !== null) {
        return storedExpectationMatches;
    }

    return originalPathMatchesWorkingCopyBytes(originalPath, workingPath);
}
