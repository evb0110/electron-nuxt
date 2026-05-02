import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import {
    dirname,
    join,
} from 'path';
import { tmpdir } from 'os';

let tempRoot = '';

vi.mock('electron', () => ({ app: { getPath: vi.fn((_name: string) => tempRoot) } }));

vi.mock('@electron/utils/pdf-decrypt', () => ({ decryptPdfFileIfNeeded: vi.fn(async () => undefined) }));

describe('workingCopy', () => {
    beforeEach(() => {
        vi.resetModules();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-working-copy-test-'));
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('recreates an active working copy directory from the original file', async () => {
        const {
            createWorkingCopyFromPath,
            ensureWorkingCopyDirectory,
            clearAllWorkingCopies,
        } = await import('@electron/ipc/workingCopy');
        const originalPath = join(tempRoot, 'original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));

        const workingPath = await createWorkingCopyFromPath(originalPath);
        rmSync(dirname(workingPath), {
            force: true,
            recursive: true,
        });

        await expect(ensureWorkingCopyDirectory(workingPath)).resolves.toBe(true);

        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            1,
            2,
            3,
        ]));

        await clearAllWorkingCopies();
    });

    it('recovers a recently cleaned working copy when a stale renderer path is reused', async () => {
        const {
            createWorkingCopyFromPath,
            ensureWorkingCopyDirectory,
            getWorkingCopyOriginalPath,
            cleanupWorkingCopy,
            clearAllWorkingCopies,
            workingCopyMap,
        } = await import('@electron/ipc/workingCopy');
        const originalPath = join(tempRoot, 'original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            4,
            5,
            6,
        ]));

        const workingPath = await createWorkingCopyFromPath(originalPath);
        cleanupWorkingCopy(workingPath);
        await vi.waitFor(() => {
            expect(existsSync(dirname(workingPath))).toBe(false);
        });

        expect(workingCopyMap.has(workingPath)).toBe(false);
        expect(getWorkingCopyOriginalPath(workingPath)).toEqual({
            originalPath,
            retired: true,
        });
        await expect(ensureWorkingCopyDirectory(workingPath)).resolves.toBe(true);

        expect(workingCopyMap.get(workingPath)).toBe(originalPath);
        expect(getWorkingCopyOriginalPath(workingPath)).toEqual({
            originalPath,
            retired: false,
        });
        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            4,
            5,
            6,
        ]));

        await clearAllWorkingCopies();
    });

    it('preserves WORKING_COPY_MISSING when both working copy and original are gone', async () => {
        const {
            WorkingCopyMissingError,
            handleFileSave,
            workingCopyMap,
            clearAllWorkingCopies,
        } = await import('@electron/ipc/workingCopy');
        const originalPath = join(tempRoot, 'missing-original.pdf');
        const workingDir = join(tempRoot, 'pdf-work-missing');
        const workingPath = join(workingDir, 'missing-original.pdf');
        workingCopyMap.set(workingPath, originalPath);

        await expect(handleFileSave({} as never, workingPath)).rejects.toBeInstanceOf(WorkingCopyMissingError);
        await expect(handleFileSave({} as never, workingPath)).rejects.toMatchObject({ code: 'WORKING_COPY_MISSING' });

        await clearAllWorkingCopies();
    });
});
