import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import {
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    atomicReplace: vi.fn(async (sourcePath: string, targetPath: string) => {
        await writeFile(targetPath, await readFile(sourcePath));
        await unlink(sourcePath);
    }),
    validatePdfFile: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn(),
    isAllowedOriginalSavePath: vi.fn(),
}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: [string, string]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/features/documents/main/pdfConformance', () => ({validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args)}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    getWorkingCopyOriginalPath: (...args: unknown[]) => mocks.getWorkingCopyOriginalPath(...args),
    normalizePathForLookup: (path: string) => path.trim(),
}));
vi.mock('@electron/file-access/isAllowedOriginalSavePath', () => ({isAllowedOriginalSavePath: (...args: unknown[]) => mocks.isAllowedOriginalSavePath(...args)}));

describe('workingCopySave', () => {
    let tempRoot = '';
    const event = {sender: {id: 42}} as Electron.IpcMainInvokeEvent;

    beforeEach(() => {
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-working-copy-save-test-'));
        mocks.validatePdfFile.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.isAllowedOriginalSavePath.mockReturnValue(true);
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('routes working-copy save through the shared mutation queue before reading the working file', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        writeFileSync(workingPath, 'new-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const queuedMutation = deferred<undefined>();
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockingMutation = enqueueWorkingCopyMutation(workingPath, () => queuedMutation.promise);
        const { handleFileSave } = await import('@electron/features/documents/main/workingCopySave');

        const savePromise = handleFileSave(event, workingPath);
        await waitForSettledQueueTurn();

        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();

        queuedMutation.resolve(undefined);
        await blockingMutation;
        await expect(savePromise).resolves.toBe(true);
        expect(readFileSyncUtf8(originalPath)).toBe('new-working');
        expect(mocks.atomicReplace).toHaveBeenCalledWith(`${originalPath}.tmp`, originalPath);
    });

    it('routes serialized PDF save and working-copy copy-back through the shared mutation queue', async () => {
        const workingPath = join(tempRoot, 'serialized-working.pdf');
        const originalPath = join(tempRoot, 'serialized-original.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const queuedMutation = deferred<undefined>();
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockingMutation = enqueueWorkingCopyMutation(workingPath, () => queuedMutation.promise);
        const { handleSerializedPdfSave } = await import('@electron/features/documents/main/workingCopySave');

        const savePromise = handleSerializedPdfSave(event, workingPath, Buffer.from('serialized-pdf'));
        await waitForSettledQueueTurn();

        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();

        queuedMutation.resolve(undefined);
        await blockingMutation;
        await expect(savePromise).resolves.toMatchObject({isValid: true});
        expect(readFileSyncUtf8(workingPath)).toBe('serialized-pdf');
        expect(readFileSyncUtf8(originalPath)).toBe('serialized-pdf');
    });
});

function readFileSyncUtf8(path: string) {
    return readFileSync(path, 'utf8');
}

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
    await delay(20);
}
