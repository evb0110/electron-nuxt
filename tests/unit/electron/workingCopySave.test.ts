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
    getWorkingCopyOriginalFileExpectation: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn(),
    isAllowedOriginalSavePath: vi.fn(),
    getNativeToolPaths: vi.fn(),
    runNativeToolCommand: vi.fn(),
    copyFileCopyOnWrite: vi.fn(),
}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: [string, string]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/features/documents/main/pdfConformance', () => ({validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args)}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    getWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.getWorkingCopyOriginalFileExpectation(...args),
    getWorkingCopyOriginalPath: (...args: unknown[]) => mocks.getWorkingCopyOriginalPath(...args),
    normalizePathForLookup: (path: string) => path.trim(),
}));
vi.mock('@electron/file-access/isAllowedOriginalSavePath', () => ({isAllowedOriginalSavePath: (...args: unknown[]) => mocks.isAllowedOriginalSavePath(...args)}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: [string, string]) => mocks.copyFileCopyOnWrite(...args)}));
vi.mock('@electron/native-tools/getNativeToolPaths', () => ({getNativeToolPaths: (...args: unknown[]) => mocks.getNativeToolPaths(...args)}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));

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
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(null);
        mocks.isAllowedOriginalSavePath.mockReturnValue(true);
        mocks.getNativeToolPaths.mockReturnValue({qpdf: '/mock/qpdf'});
        mocks.runNativeToolCommand.mockResolvedValue({
            code: 0,
            signal: null,
            stdout: '',
            stderr: '',
        });
        mocks.copyFileCopyOnWrite.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
        });
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

    it('skips copy-back when the original file changed since the working copy was opened', async () => {
        const workingPath = join(tempRoot, 'changed-working.pdf');
        const originalPath = join(tempRoot, 'changed-original.pdf');
        writeFileSync(workingPath, 'old-original');
        writeFileSync(originalPath, 'external-change');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: 1,
            size: 12,
        });
        const { handleSerializedPdfSave } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleSerializedPdfSave(event, workingPath, Buffer.from('serialized-pdf')))
            .resolves.toMatchObject({
                isValid: false,
                errors: [expect.stringContaining('Original file changed on disk')],
            });

        expect(readFileSyncUtf8(workingPath)).toBe('old-original');
        expect(readFileSyncUtf8(originalPath)).toBe('external-change');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
    });

    it('reports serialized save success with a warning when copy-back fails after replacing the original', async () => {
        const workingPath = join(tempRoot, 'copyback-working.pdf');
        const originalPath = join(tempRoot, 'copyback-original.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.copyFileCopyOnWrite.mockRejectedValueOnce(new Error('copy-back failed'));
        const { handleSerializedPdfSave } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleSerializedPdfSave(event, workingPath, Buffer.from('serialized-pdf')))
            .resolves
            .toMatchObject({
                isValid: true,
                warnings: [expect.stringContaining('copy-back failed')],
            });

        expect(readFileSyncUtf8(originalPath)).toBe('serialized-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
    });

    it('repairs through qpdf before atomically replacing the original and working copy', async () => {
        const workingPath = join(tempRoot, 'repair-working.pdf');
        const originalPath = join(tempRoot, 'repair-original.pdf');
        writeFileSync(workingPath, 'damaged-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.runNativeToolCommand.mockImplementationOnce(async (_qpdf: string, args: string[]) => {
            await writeFile(args[1] ?? '', 'repaired-pdf');
            return {
                code: 0,
                signal: null,
                stdout: '',
                stderr: '',
            };
        });
        const { handleRepairPdfSave } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleRepairPdfSave(event, workingPath)).resolves.toMatchObject({isValid: true});

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith('/mock/qpdf', [
            workingPath,
            `${originalPath}.tmp`,
        ], expect.objectContaining({
            allowedExitCodes: [
                0,
                3,
            ],
            commandLabel: 'qpdf(repair-save)',
        }));
        expect(readFileSyncUtf8(originalPath)).toBe('repaired-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('repaired-pdf');
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
