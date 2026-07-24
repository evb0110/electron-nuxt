import {
    mkdtemp,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createOriginalFileContentFingerprint } from '@electron/file-access/workingCopyOriginalFileExpectation';

const mocks = vi.hoisted(() => ({getWorkingCopyOriginalFileExpectation: vi.fn()}));

vi.mock('@electron/file-access/workingCopyStore', () => ({getWorkingCopyOriginalFileExpectation: mocks.getWorkingCopyOriginalFileExpectation}));

const { originalPathSaveBaseMatches } = await import('@electron/features/documents/main/originalPathSaveBaseMatches');

describe('originalPathSaveBaseMatches', () => {
    let tempDir = '';

    beforeEach(async () => {
        vi.clearAllMocks();
        tempDir = await mkdtemp(join(tmpdir(), 'save-base-matches-test-'));
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            size: 1,
            mtimeMs: 1,
        });
    });

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('matches fallback bytes without full-file reads', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const workingPath = join(tempDir, 'working.pdf');
        const bytes = Buffer.alloc((1024 * 1024) + 3, 7);
        await Promise.all([
            writeFile(originalPath, bytes),
            writeFile(workingPath, bytes),
        ]);

        await expect(originalPathSaveBaseMatches(workingPath, originalPath, 12)).resolves.toBe(true);
    });

    it('returns false when fallback chunk comparison differs', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const workingPath = join(tempDir, 'working.pdf');
        const originalBytes = Buffer.alloc((1024 * 1024) + 3, 7);
        const workingBytes = Buffer.from(originalBytes);
        workingBytes[1024 * 1024] = 8;
        await Promise.all([
            writeFile(originalPath, originalBytes),
            writeFile(workingPath, workingBytes),
        ]);

        await expect(originalPathSaveBaseMatches(workingPath, originalPath, 12)).resolves.toBe(false);
    });

    it('returns false when same-size same-mtime original content differs from the working base', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const workingPath = join(tempDir, 'working.pdf');
        await Promise.all([
            writeFile(originalPath, Buffer.from('edit')),
            writeFile(workingPath, Buffer.from('base')),
        ]);
        const originalStat = await stat(originalPath);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            size: originalStat.size,
            mtimeMs: originalStat.mtimeMs,
        });

        await expect(originalPathSaveBaseMatches(workingPath, originalPath, 12)).resolves.toBe(false);
    });

    it('uses the materialization-compatible streamed hash to detect same-size same-mtime edits', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const workingPath = join(tempDir, 'working.pdf');
        const baseBytes = Buffer.alloc(3 * 1024 * 1024, 7);
        const editedBytes = Buffer.from(baseBytes);
        editedBytes[Math.floor(editedBytes.byteLength / 2)] = 8;
        await Promise.all([
            writeFile(originalPath, editedBytes),
            writeFile(workingPath, baseBytes),
        ]);
        const originalStat = await stat(originalPath);
        const sourceFingerprint = await createOriginalFileContentFingerprint(workingPath, baseBytes.byteLength);
        expect(sourceFingerprint).toMatch(/^sha256-full-v1:/u);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            contentFingerprint: sourceFingerprint,
            size: originalStat.size,
            mtimeMs: originalStat.mtimeMs,
        });

        await expect(originalPathSaveBaseMatches(workingPath, originalPath, 12)).resolves.toBe(false);
    });

    it('returns false for a missing original expectation when the original no longer matches the working base', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const workingPath = join(tempDir, 'working.pdf');
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(null);
        await Promise.all([
            writeFile(originalPath, Buffer.from('external-change')),
            writeFile(workingPath, Buffer.from('opened-baseline')),
        ]);

        await expect(originalPathSaveBaseMatches(workingPath, originalPath, 12)).resolves.toBe(false);
    });
});
