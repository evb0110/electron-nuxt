import {
    mkdtemp,
    rm,
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
});
