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
    statSync,
    writeFileSync,
} from 'fs';
import {
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createOriginalFileContentFingerprintSync } from '@electron/file-access/workingCopyOriginalFileExpectation';
import {requireDocumentRevisionToken} from '@contracts';

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
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
    isAllowedOriginalSavePath: vi.fn(),
    getPdfNativeToolPaths: vi.fn(),
    runNativeToolCommand: vi.fn(),
    optimizeLargePdfForSave: vi.fn(),
    optimizePdfForSave: vi.fn(),
    copyFileCopyOnWrite: vi.fn(),
    assertWorkingCopyMutationAllowed: vi.fn(),
    assertWorkingCopyResyncAllowed: vi.fn(),
    assertWorkingCopyRevisionCurrent: vi.fn(),
    awaitWorkingCopyRevisionDurability: vi.fn(),
    markWorkingCopySyncRequired: vi.fn(),
    clearWorkingCopySyncRequired: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    transitionWorkingCopyContentRevision: vi.fn(),
}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: [string, string]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/features/documents/main/pdfConformance', () => ({validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args)}));
vi.mock('@electron/features/documents/main/pdfSaveAsOptimization', () => ({
    optimizeLargePdfForSave: (...args: unknown[]) => mocks.optimizeLargePdfForSave(...args),
    optimizePdfForSave: (...args: unknown[]) => mocks.optimizePdfForSave(...args),
}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    getWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.getWorkingCopyOriginalFileExpectation(...args),
    getWorkingCopyOriginalPath: (...args: unknown[]) => mocks.getWorkingCopyOriginalPath(...args),
    normalizePathForLookup: (path: string) => path.trim(),
    refreshWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.refreshWorkingCopyOriginalFileExpectation(...args),
}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({
    assertWorkingCopyMutationAllowed: (...args: unknown[]) => mocks.assertWorkingCopyMutationAllowed(...args),
    assertWorkingCopyResyncAllowed: (...args: unknown[]) => mocks.assertWorkingCopyResyncAllowed(...args),
    assertWorkingCopyRevisionCurrent: (...args: unknown[]) => mocks.assertWorkingCopyRevisionCurrent(...args),
    awaitWorkingCopyRevisionDurability: (...args: unknown[]) => mocks.awaitWorkingCopyRevisionDurability(...args),
    clearWorkingCopySyncRequired: (...args: unknown[]) => mocks.clearWorkingCopySyncRequired(...args),
    markWorkingCopyContentChanged: (...args: unknown[]) => mocks.markWorkingCopyContentChanged(...args),
    markWorkingCopySyncRequired: (...args: unknown[]) => mocks.markWorkingCopySyncRequired(...args),
    transitionWorkingCopyContentRevision: (...args: unknown[]) => mocks.transitionWorkingCopyContentRevision(...args),
}));
vi.mock('@electron/file-access/isAllowedOriginalSavePath', () => ({isAllowedOriginalSavePath: (...args: unknown[]) => mocks.isAllowedOriginalSavePath(...args)}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: [string, string]) => mocks.copyFileCopyOnWrite(...args)}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: (...args: unknown[]) => mocks.getPdfNativeToolPaths(...args)}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));

function createOriginalFileExpectationForTest(originalPath: string) {
    const originalStat = statSync(originalPath);
    const contentFingerprint = createOriginalFileContentFingerprintSync(originalPath, originalStat.size);
    return {
        contentFingerprint,
        mtimeMs: originalStat.mtimeMs,
        size: originalStat.size,
    };
}

describe('workingCopySave', () => {
    let tempRoot = '';
    const context = {senderId: 42};
    const revisionOptions = {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-save')};

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
        mocks.getWorkingCopyOriginalFileExpectation.mockImplementation((workingPath: string, senderWebContentsId?: number) => {
            const original = mocks.getWorkingCopyOriginalPath(workingPath, senderWebContentsId);
            return original?.originalPath
                ? createOriginalFileExpectationForTest(original.originalPath)
                : null;
        });
        mocks.isAllowedOriginalSavePath.mockReturnValue(true);
        mocks.getPdfNativeToolPaths.mockReturnValue({qpdf: '/mock/qpdf'});
        mocks.runNativeToolCommand.mockResolvedValue({
            code: 0,
            signal: null,
            stdout: '',
            stderr: '',
        });
        mocks.optimizeLargePdfForSave.mockResolvedValue(null);
        mocks.optimizePdfForSave.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.assertWorkingCopyMutationAllowed.mockResolvedValue(undefined);
        mocks.assertWorkingCopyResyncAllowed.mockReturnValue(undefined);
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        mocks.awaitWorkingCopyRevisionDurability.mockResolvedValue(undefined);
        mocks.refreshWorkingCopyOriginalFileExpectation.mockResolvedValue(true);
        mocks.markWorkingCopyContentChanged.mockResolvedValue({});
        mocks.transitionWorkingCopyContentRevision.mockImplementation(async (
            workingCopyPath: string,
            reason: string,
            commit: (revision: unknown) => Promise<void>,
        ) => {
            const previousBytes = await readFile(workingCopyPath);
            const revision = {
                token: requireDocumentRevisionToken('revision-after-save'),
                version: 1,
                documentRef: workingCopyPath,
                authority: 'electron-working-copy',
                contentRevision: 2,
                mintedAt: Date.now(),
                reason,
            };
            try {
                await commit(revision);
            } catch (error) {
                await writeFile(workingCopyPath, previousBytes);
                throw error;
            }
            return revision;
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
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');

        const savePromise = handleFileSaveStructured(context, workingPath, revisionOptions);
        await waitForSettledQueueTurn();

        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();

        queuedMutation.resolve(undefined);
        await blockingMutation;
        await expect(savePromise).resolves.toMatchObject({
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: true,
        });
        expect(readFileSyncUtf8(originalPath)).toBe('new-working');
        expect(mocks.optimizeLargePdfForSave).toHaveBeenCalledWith(`${originalPath}.tmp`);
        expect(mocks.atomicReplace).toHaveBeenCalledWith(`${originalPath}.tmp`, originalPath);
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.atomicReplace.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.refreshWorkingCopyOriginalFileExpectation.mock.invocationCallOrder[0]!);
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('returns a structured success result for working-copy saves', async () => {
        const workingPath = join(tempRoot, 'structured-working.pdf');
        const originalPath = join(tempRoot, 'structured-original.pdf');
        writeFileSync(workingPath, 'new-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleFileSaveStructured(context, workingPath, revisionOptions))
            .resolves
            .toMatchObject({
                ok: true,
                externalWriteCommitted: true,
                workingCopyRefreshed: true,
                validation: {isValid: true},
            });
        expect(readFileSyncUtf8(originalPath)).toBe('new-working');
    });

    it('copies optimized structured save bytes back to the working copy after the original write commits', async () => {
        const workingPath = join(tempRoot, 'structured-optimized-working.pdf');
        const originalPath = join(tempRoot, 'structured-optimized-original.pdf');
        writeFileSync(workingPath, 'unoptimized-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.optimizeLargePdfForSave.mockImplementationOnce(async (tempPath: string) => {
            writeFileSync(tempPath, 'optimized-pdf');
            return {
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            };
        });
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleFileSaveStructured(context, workingPath, revisionOptions))
            .resolves
            .toMatchObject({
                ok: true,
                externalWriteCommitted: true,
                workingCopyRefreshed: true,
            });

        expect(readFileSyncUtf8(originalPath)).toBe('optimized-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('optimized-pdf');
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('returns structured failure when original refresh fails after save', async () => {
        const workingPath = join(tempRoot, 'refresh-fail-working.pdf');
        const originalPath = join(tempRoot, 'refresh-fail-original.pdf');
        writeFileSync(workingPath, 'new-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.refreshWorkingCopyOriginalFileExpectation.mockImplementationOnce(() => {
            throw new Error('refresh failed');
        });
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleFileSaveStructured(context, workingPath, revisionOptions))
            .resolves
            .toMatchObject({
                ok: false,
                reason: 'write-failed',
                message: 'refresh failed',
                externalWriteCommitted: false,
                validation: null,
            });
        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
    });

    it('resyncs from the latest original mapping even when normal mutations are sync-blocked', async () => {
        const workingPath = join(tempRoot, 'resync-working.pdf');
        const firstOriginalPath = join(tempRoot, 'resync-first-original.pdf');
        const secondOriginalPath = join(tempRoot, 'resync-second-original.pdf');
        writeFileSync(workingPath, 'stale-working');
        writeFileSync(firstOriginalPath, 'first-original');
        writeFileSync(secondOriginalPath, 'second-original');
        let currentOriginalPath = firstOriginalPath;
        mocks.getWorkingCopyOriginalPath.mockImplementation(() => ({originalPath: currentOriginalPath}));
        mocks.assertWorkingCopyMutationAllowed.mockImplementation(() => {
            throw new Error('working copy sync required');
        });
        const queuedMutation = deferred<undefined>();
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockingMutation = enqueueWorkingCopyMutation(workingPath, () => queuedMutation.promise);
        const { handleResyncWorkingCopy } = await import('@electron/features/documents/main/workingCopySave');

        const resyncPromise = handleResyncWorkingCopy(context, workingPath);
        await waitForSettledQueueTurn();
        currentOriginalPath = secondOriginalPath;
        queuedMutation.resolve(undefined);
        await blockingMutation;

        await expect(resyncPromise).resolves.toMatchObject({
            ok: true,
            externalWriteCommitted: false,
            workingCopyRefreshed: true,
        });
        expect(readFileSyncUtf8(workingPath)).toBe('second-original');
        expect(mocks.assertWorkingCopyMutationAllowed).not.toHaveBeenCalled();
        expect(mocks.assertWorkingCopyResyncAllowed).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.clearWorkingCopySyncRequired).toHaveBeenCalledWith(workingPath);
        expect(mocks.markWorkingCopyContentChanged).toHaveBeenCalledWith(workingPath, 'save-sync', 42);
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

        await expect(handleRepairPdfSave(context, workingPath, revisionOptions)).resolves.toMatchObject({isValid: true});

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
        expect(mocks.optimizeLargePdfForSave).toHaveBeenCalledWith(`${originalPath}.tmp`);
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('optimizes the current PDF for interaction through qpdf before replacing the original', async () => {
        const workingPath = join(tempRoot, 'optimize-working.pdf');
        const originalPath = join(tempRoot, 'optimize-original.pdf');
        writeFileSync(workingPath, 'working-pdf');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const { handleOptimizePdfForInteraction } =
            await import('@electron/features/documents/main/workingCopySave');

        await expect(handleOptimizePdfForInteraction(context, workingPath, revisionOptions)).resolves.toMatchObject({isValid: true});

        expect(mocks.optimizePdfForSave).toHaveBeenCalledWith(`${originalPath}.tmp`, {
            force: true,
            label: 'qpdf(optimize-current-pdf)',
        });
        expect(readFileSyncUtf8(originalPath)).toBe('working-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('working-pdf');
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
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
