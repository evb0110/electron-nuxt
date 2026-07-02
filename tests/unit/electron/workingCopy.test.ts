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
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from 'fs';
import {
    dirname,
    join,
} from 'path';
import { tmpdir } from 'os';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';

let tempRoot = '';

vi.mock('electron', () => ({ app: { getPath: vi.fn((_name: string) => tempRoot) } }));

vi.mock('@electron/utils/decryptPdfFileIfNeeded', () => ({ decryptPdfFileIfNeeded: vi.fn(async () => undefined) }));

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
        } = await import('@electron/file-access/workingCopyCreation');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const originalPath = join(tempRoot, 'original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!);
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
        } = await import('@electron/file-access/workingCopyCreation');
        const { getWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const {
            cleanupWorkingCopy,
            clearAllWorkingCopies,
        } = await import('@electron/file-access/workingCopyCleanup');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const originalPath = join(tempRoot, 'original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            4,
            5,
            6,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();
        const canonicalOriginalPath = realpathSync.native(originalPath);

        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!);
        cleanupWorkingCopy(workingPath);
        await vi.waitFor(() => {
            expect(existsSync(dirname(workingPath))).toBe(false);
        });

        expect(getWorkingCopyOriginalPath(workingPath)).toEqual({
            originalPath: canonicalOriginalPath,
            retired: true,
        });
        await expect(ensureWorkingCopyDirectory(workingPath)).resolves.toBe(true);

        expect(getWorkingCopyOriginalPath(workingPath)).toEqual({
            originalPath: canonicalOriginalPath,
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
        const { WorkingCopyMissingError } = await import('@electron/file-access/workingCopyMissingError');
        const { handleFileSave } = await import('@electron/features/documents/main/workingCopySave');
        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const originalPath = join(tempRoot, 'missing-original.pdf');
        const workingDir = join(tempRoot, 'pdf-work-missing');
        const workingPath = join(workingDir, 'missing-original.pdf');
        setWorkingCopyOriginalPath(workingPath, originalPath);

        const context = {senderId: 1};
        await expect(handleFileSave(context, workingPath)).rejects.toBeInstanceOf(WorkingCopyMissingError);
        await expect(handleFileSave(context, workingPath)).rejects.toMatchObject({ code: 'WORKING_COPY_MISSING' });

        await clearAllWorkingCopies();
    });

    it('rejects unmanaged existing paths as managed working-copy sources', async () => {
        const { requireManagedWorkingCopyPath } = await import('@electron/file-access/workingCopyCreation');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const unmanagedPath = join(tempRoot, 'unmanaged.pdf');
        writeFileSync(unmanagedPath, new Uint8Array([
            7,
            8,
            9,
        ]));

        await expect(requireManagedWorkingCopyPath(unmanagedPath))
            .rejects.toThrow('Source path is not a managed working copy');

        await clearAllWorkingCopies();
    });

    it('matches Windows original paths by normalized identity', async () => {
        const {
            findWorkingCopyPathByOriginalPath,
            isKnownWorkingCopyOriginalPath,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const workingPath = 'C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\Book.pdf';
        const originalPath = 'C:\\Users\\Alice\\Documents\\Book.pdf';
        setWorkingCopyOriginalPath(workingPath, originalPath);

        expect(findWorkingCopyPathByOriginalPath('c:/users/alice/documents/book.pdf')).toBe(workingPath);
        expect(isKnownWorkingCopyOriginalPath('\\\\?\\C:\\Users\\Alice\\Documents\\Book.pdf')).toBe(true);

        await clearAllWorkingCopies();
    });

    it('keeps original-path remapping scoped to the owning sender', async () => {
        const {
            findWorkingCopyPathByOriginalPath,
            isKnownWorkingCopyOriginalPath,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const workingPath = join(tempRoot, 'pdf-work-owned', 'Book.pdf');
        const originalPath = join(tempRoot, 'Book.pdf');
        setWorkingCopyOriginalPath(workingPath, originalPath, 10);

        expect(findWorkingCopyPathByOriginalPath(originalPath, 10)).toBe(workingPath);
        expect(isKnownWorkingCopyOriginalPath(originalPath, 10)).toBe(true);
        expect(findWorkingCopyPathByOriginalPath(originalPath, 11)).toBeNull();
        expect(isKnownWorkingCopyOriginalPath(originalPath, 11)).toBe(false);

        await clearAllWorkingCopies();
    });

    it('keeps snapshot clones out of original-path current resolution', async () => {
        const {
            createWorkingCopyFromData,
            createWorkingCopyFromPath,
        } = await import('@electron/file-access/workingCopyCreation');
        const {
            findWorkingCopyPathByOriginalPath,
            getWorkingCopyOriginalPath,
            getWorkingCopyRole,
        } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const originalPath = join(tempRoot, 'snapshot-original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            10,
            11,
            12,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const currentWorkingPath = await createWorkingCopyFromPath(trustedOriginalPath!);
        const snapshotWorkingPath = await createWorkingCopyFromPath(currentWorkingPath as TOpenPath, originalPath);
        const dataSnapshotWorkingPath = await createWorkingCopyFromData(
            'snapshot-original.pdf',
            new Uint8Array([
                13,
                14,
                15,
            ]),
            originalPath,
        );

        expect(snapshotWorkingPath).not.toBe(currentWorkingPath);
        expect(getWorkingCopyRole(snapshotWorkingPath)).toBe('snapshot');
        expect(getWorkingCopyRole(dataSnapshotWorkingPath)).toBe('snapshot');
        expect(getWorkingCopyOriginalPath(snapshotWorkingPath)).toMatchObject({originalPath});
        expect(findWorkingCopyPathByOriginalPath(originalPath)).toBe(currentWorkingPath);

        await clearAllWorkingCopies();
    });

    it('promotes the newest remaining current copy when the current mapping is retired', async () => {
        const {
            findWorkingCopyPathByOriginalPath,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const {
            cleanupWorkingCopy,
            clearAllWorkingCopies,
        } = await import('@electron/file-access/workingCopyCleanup');
        const originalPath = join(tempRoot, 'promote-original.pdf');
        const firstWorkingPath = join(tempRoot, 'pdf-work-promote-1', 'promote-original.pdf');
        const secondWorkingPath = join(tempRoot, 'pdf-work-promote-2', 'promote-original.pdf');
        writeFileSync(originalPath, new Uint8Array([1]));
        mkdirSync(dirname(firstWorkingPath), {recursive: true});
        mkdirSync(dirname(secondWorkingPath), {recursive: true});
        writeFileSync(firstWorkingPath, new Uint8Array([1]));
        writeFileSync(secondWorkingPath, new Uint8Array([1]));

        setWorkingCopyOriginalPath(firstWorkingPath, originalPath);
        setWorkingCopyOriginalPath(secondWorkingPath, originalPath);

        expect(findWorkingCopyPathByOriginalPath(originalPath)).toBe(secondWorkingPath);
        cleanupWorkingCopy(secondWorkingPath);

        expect(findWorkingCopyPathByOriginalPath(originalPath)).toBe(firstWorkingPath);

        await clearAllWorkingCopies();
    });

    it('removes stale OCR sidecar directories with stale working-copy directories', async () => {
        const { cleanupStaleWorkingCopyDirectories } = await import('@electron/file-access/workingCopyCleanup');
        const appTempDir = join(tempRoot, 'evb-viewer');
        const workDir = join(appTempDir, 'pdf-work-stale-ocr');
        const ocrDir = `${workDir}.ocr`;
        mkdirSync(workDir, {recursive: true});
        mkdirSync(ocrDir, {recursive: true});
        writeFileSync(join(workDir, 'document.pdf'), new Uint8Array([1]));
        writeFileSync(join(ocrDir, 'manifest.json'), '{}');

        const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
        utimesSync(workDir, staleDate, staleDate);

        await expect(cleanupStaleWorkingCopyDirectories()).resolves.toEqual({
            removedDirectories: 1,
            removedOcrDirectories: 1,
        });
        expect(existsSync(workDir)).toBe(false);
        expect(existsSync(ocrDir)).toBe(false);
    });

    it('serializes mutation queue entries that use different spellings of one Windows path', async () => {
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockedMutation = deferred<undefined>();
        const operations: string[] = [];

        const firstMutation = enqueueWorkingCopyMutation('C:\\Temp\\pdf-work-1\\Book.pdf', async () => {
            operations.push('first-start');
            await blockedMutation.promise;
            operations.push('first-end');
        });
        const secondMutation = enqueueWorkingCopyMutation('\\\\?\\c:\\temp\\pdf-work-1\\book.pdf', async () => {
            operations.push('second-start');
        });
        await waitForSettledQueueTurn();

        expect(operations).toEqual(['first-start']);

        blockedMutation.resolve(undefined);
        await Promise.all([
            firstMutation,
            secondMutation,
        ]);

        expect(operations).toEqual([
            'first-start',
            'first-end',
            'second-start',
        ]);
    });

    it('waits for queued mutations before clearing all working copies', async () => {
        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const originalPath = join(tempRoot, 'drain-original.pdf');
        const workingDir = join(tempRoot, 'evb-viewer', 'pdf-work-drain');
        const workingPath = join(workingDir, 'drain-original.pdf');
        const blockedMutation = deferred<undefined>();
        const operations: string[] = [];
        mkdirSync(workingDir, {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));
        setWorkingCopyOriginalPath(workingPath, originalPath);

        const mutation = enqueueWorkingCopyMutation(workingPath, async () => {
            operations.push('mutation-start');
            await blockedMutation.promise;
            operations.push(`dir-exists:${existsSync(workingDir)}`);
        });
        await waitForSettledQueueTurn();

        const clearPromise = clearAllWorkingCopies().then(() => {
            operations.push('clear-done');
        });
        await waitForSettledQueueTurn();

        expect(existsSync(workingDir)).toBe(true);
        expect(operations).toEqual(['mutation-start']);

        blockedMutation.resolve(undefined);
        await mutation;
        await clearPromise;

        expect(operations).toEqual([
            'mutation-start',
            'dir-exists:true',
            'clear-done',
        ]);
        expect(existsSync(workingDir)).toBe(false);
    });
});

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

async function waitForSettledQueueTurn() {
    await new Promise(resolve => setTimeout(resolve, 20));
}
