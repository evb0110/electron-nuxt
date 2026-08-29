import {createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {
    open,
    stat,
    type FileHandle,
} from 'node:fs/promises';
import {
    getWorkingCopyOriginalFileExpectation,
    type IWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import {isErrnoException} from '@contracts/runtimeGuards';

const SAVE_WITNESS_SAMPLE_BYTES = 64 * 1024;

interface IOriginalPathSaveSnapshot {
    ctimeNs: bigint;
    deviceId: bigint;
    inode: bigint;
    linkCount: bigint;
    mtimeNs: bigint;
    sampleSha256: string;
    size: bigint;
}

export class OriginalPathSaveConflictError extends Error {
    constructor() {
        super('Original file changed on disk; save skipped to avoid overwriting external edits');
        this.name = 'OriginalPathSaveConflictError';
    }
}

export interface IOriginalPathSaveWitness {
    assertCurrent: () => Promise<void>;
    close: () => Promise<void>;
    rebaseAfterBackup: () => Promise<void>;
}

function expectationMatchesStat(
    expected: IWorkingCopyOriginalFileExpectation,
    actual: BigIntStats,
) {
    const matches = {
        ctime: expected.ctimeNs === undefined || actual.ctimeNs.toString() === expected.ctimeNs,
        device: expected.deviceId === undefined || actual.dev.toString() === expected.deviceId,
        file: actual.isFile(),
        inode: expected.inode === undefined || actual.ino.toString() === expected.inode,
        mtime: expected.mtimeNs === undefined || actual.mtimeNs.toString() === expected.mtimeNs,
        size: actual.size === BigInt(expected.size),
    };
    if (Object.values(matches).includes(false)) {
        return false;
    }

    return expected.mtimeNs !== undefined
        || Math.abs(Number(actual.mtimeNs) / 1_000_000 - expected.mtimeMs) < 1;
}

function snapshotsMatch(
    left: IOriginalPathSaveSnapshot,
    right: IOriginalPathSaveSnapshot,
    options: {allowBackupMetadataChange?: boolean} = {},
) {
    return left.deviceId === right.deviceId
        && left.inode === right.inode
        && left.mtimeNs === right.mtimeNs
        && left.sampleSha256 === right.sampleSha256
        && left.size === right.size
        && (options.allowBackupMetadataChange === true || (
            left.ctimeNs === right.ctimeNs
            && left.linkCount === right.linkCount
        ));
}

async function sampleFileHandle(handle: FileHandle, size: bigint) {
    const numericSize = Number(size);
    if (!Number.isSafeInteger(numericSize) || numericSize < 0) {
        throw new OriginalPathSaveConflictError();
    }
    const sampleLength = Math.min(numericSize, SAVE_WITNESS_SAMPLE_BYTES);
    const lastOffset = numericSize - sampleLength;
    const offsets = [...new Set([
        0,
        Math.floor(lastOffset / 2),
        lastOffset,
    ])];
    const hash = createHash('sha256');
    for (const offset of offsets) {
        const sample = Buffer.allocUnsafe(sampleLength);
        const {bytesRead} = await handle.read(sample, 0, sampleLength, offset);
        if (bytesRead !== sampleLength) {
            throw new OriginalPathSaveConflictError();
        }
        hash.update(`${offset}:${bytesRead}:`);
        hash.update(sample);
    }
    return hash.digest('hex');
}

async function captureHandleSnapshot(handle: FileHandle): Promise<IOriginalPathSaveSnapshot> {
    const before = await handle.stat({bigint: true});
    if (!before.isFile()) {
        throw new OriginalPathSaveConflictError();
    }
    const sampleSha256 = await sampleFileHandle(handle, before.size);
    const after = await handle.stat({bigint: true});
    const beforeSnapshot = createSnapshot(before, sampleSha256);
    const afterSnapshot = createSnapshot(after, sampleSha256);
    if (!snapshotsMatch(beforeSnapshot, afterSnapshot)) {
        throw new OriginalPathSaveConflictError();
    }
    return afterSnapshot;
}

function createSnapshot(fileStat: BigIntStats, sampleSha256: string): IOriginalPathSaveSnapshot {
    return {
        ctimeNs: fileStat.ctimeNs,
        deviceId: fileStat.dev,
        inode: fileStat.ino,
        linkCount: fileStat.nlink,
        mtimeNs: fileStat.mtimeNs,
        sampleSha256,
        size: fileStat.size,
    };
}

async function capturePathSnapshot(originalPath: string) {
    const pathHandle = await open(originalPath, 'r');
    try {
        return await captureHandleSnapshot(pathHandle);
    } finally {
        await pathHandle.close().catch(() => undefined);
    }
}

function rethrowWitnessSnapshotError(error: unknown): never {
    if (error instanceof OriginalPathSaveConflictError) {
        throw error;
    }
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        throw new OriginalPathSaveConflictError();
    }
    throw error;
}

class OriginalPathSaveWitness implements IOriginalPathSaveWitness {
    private snapshot: IOriginalPathSaveSnapshot;

    constructor(
        private readonly originalPath: string,
        private readonly handle: FileHandle,
        snapshot: IOriginalPathSaveSnapshot,
    ) {
        this.snapshot = snapshot;
    }

    async assertCurrent() {
        try {
            const [
                handleSnapshot,
                pathSnapshot,
            ] = await Promise.all([
                captureHandleSnapshot(this.handle),
                capturePathSnapshot(this.originalPath),
            ]);
            if (
                !snapshotsMatch(this.snapshot, handleSnapshot)
                || !snapshotsMatch(this.snapshot, pathSnapshot)
            ) {
                throw new OriginalPathSaveConflictError();
            }
        } catch (error) {
            rethrowWitnessSnapshotError(error);
        }
    }

    async rebaseAfterBackup() {
        try {
            const [
                handleSnapshot,
                pathSnapshot,
            ] = await Promise.all([
                captureHandleSnapshot(this.handle),
                capturePathSnapshot(this.originalPath),
            ]);
            if (
                !snapshotsMatch(this.snapshot, handleSnapshot, {allowBackupMetadataChange: true})
                || !snapshotsMatch(handleSnapshot, pathSnapshot)
            ) {
                throw new OriginalPathSaveConflictError();
            }
            this.snapshot = handleSnapshot;
        } catch (error) {
            rethrowWitnessSnapshotError(error);
        }
    }

    async close() {
        await this.handle.close().catch(() => undefined);
    }
}

export async function captureOriginalPathSaveWitness(
    workingPath: string,
    originalPath: string,
    senderWebContentsId: number,
): Promise<IOriginalPathSaveWitness | null> {
    const expected = getWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId);
    if (!expected) {
        return null;
    }

    let handle: FileHandle;
    try {
        handle = await open(originalPath, 'r');
    } catch {
        return null;
    }
    try {
        const snapshot = await captureHandleSnapshot(handle);
        const handleStat = await handle.stat({bigint: true});
        if (!expectationMatchesStat(expected, handleStat)) {
            await handle.close().catch(() => undefined);
            return null;
        }
        const pathSnapshot = await capturePathSnapshot(originalPath);
        if (!snapshotsMatch(snapshot, pathSnapshot)) {
            await handle.close().catch(() => undefined);
            return null;
        }
        return new OriginalPathSaveWitness(originalPath, handle, snapshot);
    } catch {
        await handle.close().catch(() => undefined);
        return null;
    }
}

/**
 * Fences an original-path save without reading the document bytes.
 *
 * A full SHA-256 made every annotation save proportional to the PDF size. The
 * expectation now captures filesystem identity and change timestamps when the
 * source is opened or last published. On POSIX, ctime cannot be restored by an
 * ordinary writer, so same-size and backdated external edits still fail the
 * fence. Older restored registrations may only have size and mtime; those stay
 * compatible without falling back to a whole-document comparison.
 */
export async function originalPathSaveBaseMatches(
    workingPath: string,
    originalPath: string,
    senderWebContentsId: number,
) {
    const expected = getWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId);
    if (!expected) {
        return false;
    }

    let actual;
    try {
        actual = await stat(originalPath, {bigint: true});
    } catch {
        return false;
    }
    return expectationMatchesStat(expected, actual);
}
