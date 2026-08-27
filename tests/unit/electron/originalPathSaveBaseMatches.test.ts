import {
    mkdtemp,
    rm,
    stat,
    utimes,
    writeFile,
} from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({getWorkingCopyOriginalFileExpectation: vi.fn()}));

vi.mock('@electron/file-access/workingCopyStore', () => ({getWorkingCopyOriginalFileExpectation: mocks.getWorkingCopyOriginalFileExpectation}));

const {originalPathSaveBaseMatches} = await import('@electron/features/documents/main/originalPathSaveBaseMatches');

async function captureExpectation(path: string) {
    const fileStat = await stat(path, {bigint: true});
    return {
        ctimeNs: fileStat.ctimeNs.toString(),
        deviceId: fileStat.dev.toString(),
        inode: fileStat.ino.toString(),
        mtimeMs: Number(fileStat.mtimeNs) / 1_000_000,
        mtimeNs: fileStat.mtimeNs.toString(),
        size: Number(fileStat.size),
    };
}

describe('originalPathSaveBaseMatches', () => {
    let tempDir = '';

    beforeEach(async () => {
        vi.clearAllMocks();
        tempDir = await mkdtemp(join(tmpdir(), 'save-base-matches-test-'));
    });

    afterEach(async () => {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    });

    it('matches an unchanged original from its stat witness', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(await captureExpectation(originalPath));

        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(true);
    });

    it('rejects a same-size edit even when its mtime is restored', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        const expected = await captureExpectation(originalPath);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(expected);

        await writeFile(originalPath, Buffer.from('edit'));
        const restoredSeconds = Number(BigInt(expected.mtimeNs)) / 1_000_000_000;
        await utimes(originalPath, restoredSeconds, restoredSeconds);

        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
    });

    it('rejects an atomic replacement with the same bytes', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const replacementPath = join(tempDir, 'replacement.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(await captureExpectation(originalPath));
        await writeFile(replacementPath, Buffer.from('base'));
        await rm(originalPath);
        const {rename} = await import('fs/promises');
        await rename(replacementPath, originalPath);

        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
    });

    it('keeps legacy size and mtime expectations compatible without reading bytes', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        const fileStat = await stat(originalPath);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
        });

        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(true);
    });

    it('fails closed when no original expectation exists', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(null);

        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
    });
});
