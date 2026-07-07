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
import { createStaleRevisionError } from '@contracts/documentMutationErrors';
import { createOriginalFileContentFingerprintSync } from '@electron/file-access/workingCopyOriginalFileExpectation';

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
    markWorkingCopySyncRequired: vi.fn(),
    clearWorkingCopySyncRequired: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
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
    clearWorkingCopySyncRequired: (...args: unknown[]) => mocks.clearWorkingCopySyncRequired(...args),
    markWorkingCopyContentChanged: (...args: unknown[]) => mocks.markWorkingCopyContentChanged(...args),
    markWorkingCopySyncRequired: (...args: unknown[]) => mocks.markWorkingCopySyncRequired(...args),
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
    const revisionOptions = {expectedDocumentRevisionToken: 'revision-before-save'};

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
        mocks.refreshWorkingCopyOriginalFileExpectation.mockResolvedValue(true);
        mocks.markWorkingCopyContentChanged.mockResolvedValue({});
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
        expect(mocks.markWorkingCopyContentChanged).not.toHaveBeenCalled();
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
        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledWith(originalPath, workingPath);
        expect(mocks.atomicReplace.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.copyFileCopyOnWrite.mock.invocationCallOrder[1]!);
        expect(mocks.copyFileCopyOnWrite.mock.invocationCallOrder[1]!)
            .toBeLessThan(mocks.refreshWorkingCopyOriginalFileExpectation.mock.invocationCallOrder[0]!);
        expect(mocks.markWorkingCopyContentChanged).toHaveBeenCalledWith(workingPath, 'save-sync', 42);
    });

    it('rejects structured saves without a revision token before replacing files', async () => {
        const workingPath = join(tempRoot, 'structured-missing-token-working.pdf');
        const originalPath = join(tempRoot, 'structured-missing-token-original.pdf');
        writeFileSync(workingPath, 'new-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleFileSaveStructured(context, workingPath))
            .resolves
            .toMatchObject({
                ok: false,
                reason: 'write-failed',
                externalWriteCommitted: false,
            });

        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.assertWorkingCopyRevisionCurrent).not.toHaveBeenCalled();
    });

    it('rejects structured saves with a stale revision token before replacing files', async () => {
        const workingPath = join(tempRoot, 'structured-stale-token-working.pdf');
        const originalPath = join(tempRoot, 'structured-stale-token-original.pdf');
        writeFileSync(workingPath, 'new-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.assertWorkingCopyRevisionCurrent.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: workingPath,
            expectedRevision: revisionOptions.expectedDocumentRevisionToken,
            actualRevision: 'revision-after-edit',
        }));
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleFileSaveStructured(context, workingPath, revisionOptions))
            .resolves
            .toMatchObject({
                ok: false,
                reason: 'write-failed',
                externalWriteCommitted: false,
            });

        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.assertWorkingCopyRevisionCurrent)
            .toHaveBeenCalledWith(workingPath, revisionOptions.expectedDocumentRevisionToken);
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
                reason: 'working-copy-sync-required',
                message: 'refresh failed',
                externalWriteCommitted: true,
                workingCopySyncRequired: true,
                validation: {isValid: true},
            });
        expect(mocks.markWorkingCopySyncRequired).toHaveBeenCalledWith(
            workingPath,
            expect.stringContaining('refresh failed'),
        );
        expect(readFileSyncUtf8(originalPath)).toBe('new-working');
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

        const savePromise = handleSerializedPdfSave(context, workingPath, Buffer.from('serialized-pdf'), revisionOptions);
        await waitForSettledQueueTurn();

        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();

        queuedMutation.resolve(undefined);
        await blockingMutation;
        await expect(savePromise).resolves.toMatchObject({isValid: true});
        expect(readFileSyncUtf8(workingPath)).toBe('serialized-pdf');
        expect(readFileSyncUtf8(originalPath)).toBe('serialized-pdf');
        expect(mocks.optimizeLargePdfForSave).toHaveBeenCalledWith(`${originalPath}.tmp`);
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.copyFileCopyOnWrite.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.refreshWorkingCopyOriginalFileExpectation.mock.invocationCallOrder[0]!);
        expect(mocks.markWorkingCopyContentChanged).toHaveBeenCalledWith(workingPath, 'save-sync', 42);
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

        await expect(handleSerializedPdfSave(context, workingPath, Buffer.from('serialized-pdf'), revisionOptions))
            .resolves.toMatchObject({
                isValid: false,
                errors: [expect.stringContaining('Original file changed on disk')],
            });

        expect(readFileSyncUtf8(workingPath)).toBe('old-original');
        expect(readFileSyncUtf8(originalPath)).toBe('external-change');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
    });

    it('reports serialized save failure when copy-back fails after replacing the original', async () => {
        const workingPath = join(tempRoot, 'copyback-working.pdf');
        const originalPath = join(tempRoot, 'copyback-original.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.copyFileCopyOnWrite.mockRejectedValueOnce(new Error('copy-back failed'));
        const { handleSerializedPdfSave } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleSerializedPdfSave(context, workingPath, Buffer.from('serialized-pdf'), revisionOptions))
            .resolves
            .toMatchObject({
                isValid: false,
                errors: [expect.stringContaining('copy-back failed')],
                warnings: [expect.stringContaining('copy-back failed')],
            });

        expect(readFileSyncUtf8(originalPath)).toBe('serialized-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
        expect(mocks.markWorkingCopyContentChanged).not.toHaveBeenCalled();
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
        expect(mocks.copyFileCopyOnWrite.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.refreshWorkingCopyOriginalFileExpectation.mock.invocationCallOrder[0]!);
        expect(mocks.markWorkingCopyContentChanged).toHaveBeenCalledWith(workingPath, 'save-sync', 42);
    });

    it('rejects repair saves without a revision token before running qpdf', async () => {
        const workingPath = join(tempRoot, 'repair-missing-token-working.pdf');
        const originalPath = join(tempRoot, 'repair-missing-token-original.pdf');
        writeFileSync(workingPath, 'damaged-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const { handleRepairPdfSave } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleRepairPdfSave(context, workingPath))
            .rejects
            .toThrow('Document revision token is required');

        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.assertWorkingCopyRevisionCurrent).not.toHaveBeenCalled();
    });

    it('rejects repair saves with a stale revision token before running qpdf', async () => {
        const workingPath = join(tempRoot, 'repair-stale-token-working.pdf');
        const originalPath = join(tempRoot, 'repair-stale-token-original.pdf');
        writeFileSync(workingPath, 'damaged-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.assertWorkingCopyRevisionCurrent.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: workingPath,
            expectedRevision: revisionOptions.expectedDocumentRevisionToken,
            actualRevision: 'revision-after-edit',
        }));
        const { handleRepairPdfSave } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleRepairPdfSave(context, workingPath, revisionOptions))
            .rejects
            .toThrow('Document changed while this edit was being prepared');

        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
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
        expect(mocks.markWorkingCopyContentChanged).toHaveBeenCalledWith(workingPath, 'save-sync', 42);
    });

    it('rejects interaction optimization without a revision token before optimizing', async () => {
        const workingPath = join(tempRoot, 'optimize-missing-token-working.pdf');
        const originalPath = join(tempRoot, 'optimize-missing-token-original.pdf');
        writeFileSync(workingPath, 'working-pdf');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const { handleOptimizePdfForInteraction } =
            await import('@electron/features/documents/main/workingCopySave');

        await expect(handleOptimizePdfForInteraction(context, workingPath))
            .rejects
            .toThrow('Document revision token is required');

        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.optimizePdfForSave).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.assertWorkingCopyRevisionCurrent).not.toHaveBeenCalled();
    });

    it('rejects interaction optimization with a stale revision token before optimizing', async () => {
        const workingPath = join(tempRoot, 'optimize-stale-token-working.pdf');
        const originalPath = join(tempRoot, 'optimize-stale-token-original.pdf');
        writeFileSync(workingPath, 'working-pdf');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.assertWorkingCopyRevisionCurrent.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: workingPath,
            expectedRevision: revisionOptions.expectedDocumentRevisionToken,
            actualRevision: 'revision-after-edit',
        }));
        const { handleOptimizePdfForInteraction } =
            await import('@electron/features/documents/main/workingCopySave');

        await expect(handleOptimizePdfForInteraction(context, workingPath, revisionOptions))
            .rejects
            .toThrow('Document changed while this edit was being prepared');

        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.optimizePdfForSave).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
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
