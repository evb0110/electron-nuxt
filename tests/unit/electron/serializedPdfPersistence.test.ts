import { EventEmitter } from 'node:events';
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
    existsSync,
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
import { createStaleRevisionError } from '@contracts/documentMutationErrors';
import type * as SerializedPdfPersistenceModule from '@electron/features/documents/main/serializedPdfPersistence';
import type * as WorkingCopyMutationQueueModule from '@electron/file-access/workingCopyMutationQueue';

type TSerializedPdfPersistenceModule = typeof SerializedPdfPersistenceModule;
type TWorkingCopyMutationQueueModule = typeof WorkingCopyMutationQueueModule;

interface IInvocationOrderMock { mock: { invocationCallOrder: number[] }; }

const SERIALIZED_TEST_REVISION_OPTIONS = { expectedDocumentRevisionToken: 'drt1:test:base' };

const mocks = vi.hoisted(() => ({
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    validatePdfFile: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn(),
    getWorkingCopyOriginalFileExpectation: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn<(workingPath: string, senderWebContentsId?: number) => { originalPath: string } | null>(),
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
    setWorkingCopyOriginalPath: vi.fn<(workingPath: string, originalPath: string, senderId?: number) => void>(),
    allowOpenPath: vi.fn(),
    addRecentFile: vi.fn(),
    updateRecentFilesMenu: vi.fn(),
    assertWorkingCopyRevisionCurrent: vi.fn(),
    assertWorkingCopyMutationAllowed: vi.fn(),
    getWorkingCopyRevision: vi.fn(),
    markWorkingCopySyncRequired: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    optimizePdfForSaveAs: vi.fn(),
    optimizeLargePdfForSave: vi.fn(),
    copyFileCopyOnWrite: vi.fn(),
}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/features/documents/main/pdfConformance', () => ({validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args)}));
vi.mock('@electron/features/documents/main/pdfSaveAsOptimization', () => ({
    optimizePdfForSaveAs: (...args: unknown[]) => mocks.optimizePdfForSaveAs(...args),
    optimizeLargePdfForSave: (...args: unknown[]) => mocks.optimizeLargePdfForSave(...args),
}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    getWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.getWorkingCopyOriginalFileExpectation(...args),
    getWorkingCopyOriginalPath: (...args: [string, number?]) => mocks.getWorkingCopyOriginalPath(...args),
    normalizePathForLookup: (path: string) => path.trim(),
    refreshWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.refreshWorkingCopyOriginalFileExpectation(...args),
    setWorkingCopyOriginalPath: (...args: [string, string, number?]) => mocks.setWorkingCopyOriginalPath(...args),
}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({
    assertWorkingCopyMutationAllowed: (...args: unknown[]) => mocks.assertWorkingCopyMutationAllowed(...args),
    assertWorkingCopyRevisionCurrent: (...args: unknown[]) => mocks.assertWorkingCopyRevisionCurrent(...args),
    getWorkingCopyRevision: (...args: unknown[]) => mocks.getWorkingCopyRevision(...args),
    markWorkingCopyContentChanged: (...args: unknown[]) => mocks.markWorkingCopyContentChanged(...args),
    markWorkingCopySyncRequired: (...args: unknown[]) => mocks.markWorkingCopySyncRequired(...args),
}));
vi.mock('@electron/file-access/isAllowedOriginalSavePath', () => ({isAllowedOriginalSavePath: vi.fn(() => true)}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: [string, string]) => mocks.copyFileCopyOnWrite(...args)}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args)}));
vi.mock('@electron/recentFiles', () => ({addRecentFile: (...args: unknown[]) => mocks.addRecentFile(...args)}));
vi.mock('@electron/menu', () => ({updateRecentFilesMenu: (...args: unknown[]) => mocks.updateRecentFilesMenu(...args)}));

function createOriginalFileExpectationForTest(originalPath: string) {
    const originalStat = statSync(originalPath);
    const contentFingerprint = createOriginalFileContentFingerprintSync(originalPath, originalStat.size);
    return {
        contentFingerprint,
        mtimeMs: originalStat.mtimeMs,
        size: originalStat.size,
    };
}

async function importSerializedPdfPersistence(): Promise<TSerializedPdfPersistenceModule> {
    return import('@electron/features/documents/main/serializedPdfPersistence');
}

async function importWorkingCopyMutationQueue(): Promise<TWorkingCopyMutationQueueModule> {
    return import('@electron/file-access/workingCopyMutationQueue');
}

class FakeSender extends EventEmitter {
    constructor(readonly id = 42) {
        super();
    }
}

function createInvokeEvent(sender: FakeSender) {
    return {
        sender,
        senderId: sender.id,
    } as never;
}

function createPortEvent(sender: FakeSender, port: FakeMessagePort) {
    return {
        sender,
        ports: [port],
    } as never;
}

function firstInvocationOrder(mock: IInvocationOrderMock) {
    const order = mock.mock.invocationCallOrder[0];
    if (order === undefined) {
        throw new Error('Expected mock to have been invoked');
    }
    return order;
}

describe('serializedPdfPersistence', () => {
    let tempRoot = '';

    beforeEach(() => {
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-serialized-pdf-persistence-test-'));
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
        mocks.optimizePdfForSaveAs.mockResolvedValue(null);
        mocks.optimizeLargePdfForSave.mockResolvedValue(null);
        mocks.assertWorkingCopyMutationAllowed.mockResolvedValue(undefined);
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        mocks.getWorkingCopyRevision.mockImplementation(async (workingPath: string) => ({
            version: 1,
            documentRef: workingPath,
            authority: 'electron-working-copy',
            token: 'drt1:test:main-base',
            contentRevision: 1,
            mintedAt: 1,
        }));
        mocks.markWorkingCopyContentChanged.mockResolvedValue(undefined);
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
            await unlink(sourcePath);
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

    it('updates the Save As working copy after replacing the selected target', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp`;
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');

        const result = await runSaveAsSession({
            workingPath,
            targetPath,
            bytes: Buffer.from('new-pdf'),
        });

        expect(result).toMatchObject({
            type: 'result',
            path: targetPath,
            validation: { isValid: true },
        });
        expect(readFileSyncUtf8(workingPath)).toBe('new-pdf');
        expect(readFileSyncUtf8(targetPath)).toBe('new-pdf');
        expect(existsSync(tempPath)).toBe(false);
        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, targetPath);
        expect(
            firstInvocationOrder(mocks.ensureWorkingCopyDirectory),
        ).toBeLessThan(firstInvocationOrder(mocks.makeSiblingTempPath));
        expect(
            firstInvocationOrder(mocks.ensureWorkingCopyDirectory),
        ).toBeLessThan(firstInvocationOrder(mocks.atomicReplace));
        expect(mocks.setWorkingCopyOriginalPath).toHaveBeenCalledWith(workingPath, targetPath, 42);
        expect(mocks.allowOpenPath).toHaveBeenCalledWith(targetPath, expect.objectContaining({ id: 42 }));
        expect(mocks.addRecentFile).toHaveBeenCalledWith(targetPath);
        expect(mocks.updateRecentFilesMenu).toHaveBeenCalled();
    });

    it('runs lossless optimization for streamed Save As before replacing the selected target', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp`;
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');

        const result = await runSaveAsSession({
            workingPath,
            targetPath,
            bytes: Buffer.from('new-pdf'),
            options: { optimizeLossless: true },
        });

        expect(result).toMatchObject({
            type: 'result',
            path: targetPath,
            validation: { isValid: true },
        });
        expect(mocks.optimizePdfForSaveAs).toHaveBeenCalledWith(tempPath, { optimizeLossless: true });
        expect(
            firstInvocationOrder(mocks.optimizePdfForSaveAs),
        ).toBeLessThan(firstInvocationOrder(mocks.atomicReplace));
    });

    it('preserves the Save As working copy when target replacement fails', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');
        mocks.atomicReplace.mockRejectedValueOnce(new Error('replace failed'));

        const result = await runSaveAsSession({
            workingPath,
            targetPath,
            bytes: Buffer.from('new-pdf'),
        });

        expect(result).toMatchObject({
            type: 'error',
            error: 'replace failed',
        });
        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(readFileSyncUtf8(targetPath)).toBe('old-target');
        expect(mocks.setWorkingCopyOriginalPath).not.toHaveBeenCalled();
        expect(mocks.allowOpenPath).not.toHaveBeenCalled();
        expect(mocks.addRecentFile).not.toHaveBeenCalled();
        expect(mocks.updateRecentFilesMenu).not.toHaveBeenCalled();
    });

    it('allows serialized PDF streams above the single IPC write budget', async () => {
        const workingPath = join(tempRoot, 'large-working.pdf');
        const targetPath = join(tempRoot, 'large-saved.pdf');
        const tempPath = `${targetPath}.tmp`;
        const sender = new FakeSender();
        const { beginSerializedPdfSaveAs } = await importSerializedPdfPersistence();

        const result = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            (512 * 1024 * 1024) + 1,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );

        expect(result).toMatchObject({
            sessionId: expect.any(String),
            path: targetPath,
        });
        expect(existsSync(tempPath)).toBe(true);

        sender.emit('destroyed');
        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
    });

    it('rejects impossible serialized PDF stream sizes before opening a temp file', async () => {
        const workingPath = join(tempRoot, 'oversized-working.pdf');
        const targetPath = join(tempRoot, 'oversized-saved.pdf');
        const sender = new FakeSender();
        const { beginSerializedPdfSaveAs } = await importSerializedPdfPersistence();

        await expect(beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            Number.MAX_SAFE_INTEGER,
            targetPath,
        )).rejects.toThrow('Invalid PDF persistence stream: exceeds maximum size');

        expect(mocks.makeSiblingTempPath).not.toHaveBeenCalled();
        expect(existsSync(`${targetPath}.tmp`)).toBe(false);
    });

    it('rejects Save to original when the original file changed before final replacement', async () => {
        const workingPath = join(tempRoot, 'working-save.pdf');
        const originalPath = join(tempRoot, 'original-save.pdf');
        writeFileSync(workingPath, 'old-original');
        writeFileSync(originalPath, 'external-change');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: 1,
            size: 12,
        });

        const result = await runSaveToOriginalSession({
            workingPath,
            bytes: Buffer.from('new-pdf'),
        });

        expect(result).toMatchObject({
            type: 'result',
            path: null,
            validation: {
                isValid: false,
                errors: [expect.stringContaining('Original file changed on disk')],
            },
        });
        expect(readFileSyncUtf8(workingPath)).toBe('old-original');
        expect(readFileSyncUtf8(originalPath)).toBe('external-change');
        expect(mocks.optimizeLargePdfForSave).toHaveBeenCalledWith(`${originalPath}.tmp`);
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
    });

    it('rejects Save to original when the working-copy revision changed before final replacement', async () => {
        const workingPath = join(tempRoot, 'working-stale-revision.pdf');
        const originalPath = join(tempRoot, 'original-stale-revision.pdf');
        writeFileSync(workingPath, 'newer-working-copy');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.assertWorkingCopyRevisionCurrent.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: workingPath,
            expectedRevision: 'drt1:test:base',
            actualRevision: 'drt1:test:newer',
        }));

        const result = await runSaveToOriginalSession({
            workingPath,
            bytes: Buffer.from('stale-serialized-pdf'),
            serializedSaveOptions: { expectedDocumentRevisionToken: 'drt1:test:base' },
        });

        expect(result).toMatchObject({
            type: 'error',
            code: 'STALE_REVISION',
            phase: 'complete',
            retryable: true,
            expected: true,
        });
        expect(mocks.assertWorkingCopyRevisionCurrent).toHaveBeenCalledWith(workingPath, 'drt1:test:base');
        expect(readFileSyncUtf8(workingPath)).toBe('newer-working-copy');
        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
    });

    it('rejects streamed Save to original when the caller-provided base revision goes stale', async () => {
        const workingPath = join(tempRoot, 'working-main-captured-stale.pdf');
        const originalPath = join(tempRoot, 'original-main-captured-stale.pdf');
        writeFileSync(workingPath, 'newer-working-copy');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.assertWorkingCopyRevisionCurrent.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: workingPath,
            expectedRevision: 'drt1:test:caller-base',
            actualRevision: 'drt1:test:page-op',
        }));

        const result = await runSaveToOriginalSession({
            workingPath,
            bytes: Buffer.from('stale-serialized-pdf'),
            serializedSaveOptions: { expectedDocumentRevisionToken: 'drt1:test:caller-base' },
        });

        expect(result).toMatchObject({
            type: 'error',
            code: 'STALE_REVISION',
            phase: 'complete',
            retryable: true,
            expected: true,
        });
        expect(mocks.getWorkingCopyRevision).not.toHaveBeenCalled();
        expect(mocks.assertWorkingCopyRevisionCurrent).toHaveBeenCalledWith(workingPath, 'drt1:test:caller-base');
        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
    });

    it('rejects Save As when the working-copy revision changed before target replacement', async () => {
        const workingPath = join(tempRoot, 'working-save-as-stale-revision.pdf');
        const targetPath = join(tempRoot, 'target-save-as-stale-revision.pdf');
        writeFileSync(workingPath, 'newer-working-copy');
        writeFileSync(targetPath, 'old-target');
        mocks.assertWorkingCopyRevisionCurrent.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: workingPath,
            expectedRevision: 'drt1:test:save-as-base',
            actualRevision: 'drt1:test:newer-save-as',
        }));

        const result = await runSaveAsSession({
            workingPath,
            targetPath,
            bytes: Buffer.from('stale-serialized-pdf'),
            serializedSaveOptions: { expectedDocumentRevisionToken: 'drt1:test:save-as-base' },
        });

        expect(result).toMatchObject({
            type: 'error',
            code: 'STALE_REVISION',
            phase: 'complete',
            retryable: true,
            expected: true,
        });
        expect(mocks.assertWorkingCopyRevisionCurrent).toHaveBeenCalledWith(workingPath, 'drt1:test:save-as-base');
        expect(readFileSyncUtf8(workingPath)).toBe('newer-working-copy');
        expect(readFileSyncUtf8(targetPath)).toBe('old-target');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.setWorkingCopyOriginalPath).not.toHaveBeenCalled();
    });

    it('returns committed failure when streamed Save to original copy-back fails', async () => {
        const workingPath = join(tempRoot, 'copyback-working.pdf');
        const originalPath = join(tempRoot, 'copyback-original.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.copyFileCopyOnWrite.mockRejectedValueOnce(new Error('copy-back failed'));

        const result = await runSaveToOriginalSession({
            workingPath,
            bytes: Buffer.from('new-pdf'),
        });

        expect(result).toMatchObject({
            type: 'result',
            path: null,
            validation: {
                isValid: false,
                errors: [expect.stringContaining('copy-back failed')],
                warnings: [expect.stringContaining('copy-back failed')],
            },
        });
        expect(readFileSyncUtf8(originalPath)).toBe('new-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(mocks.optimizeLargePdfForSave).toHaveBeenCalledWith(`${originalPath}.tmp`);
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
    });

    it('waits for an in-flight streamed commit during shutdown before cleanup', async () => {
        const workingPath = join(tempRoot, 'shutdown-working.pdf');
        const targetPath = join(tempRoot, 'shutdown-target.pdf');
        const replaceGate = deferred<undefined>();
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');
        mocks.atomicReplace.mockImplementationOnce(async (sourcePath: string, replaceTargetPath: string) => {
            await replaceGate.promise;
            await writeFile(replaceTargetPath, await readFile(sourcePath));
            await unlink(sourcePath);
        });
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
            shutdownSerializedPdfPersistence,
        } = await importSerializedPdfPersistence();
        const sender = new FakeSender();
        const port = new FakeMessagePort();
        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            Buffer.byteLength('new-pdf'),
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        const resultPromise = port.nextResult();

        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);
        port.emit('message', {data: {
            type: 'chunk',
            seq: 0,
            bytes: Buffer.from('new-pdf'),
        }});
        port.emit('message', {data: {type: 'complete'}});

        await waitForCondition(() => {
            expect(mocks.atomicReplace).toHaveBeenCalledOnce();
        });

        let shutdownSettled = false;
        const shutdownPromise = shutdownSerializedPdfPersistence().then(() => {
            shutdownSettled = true;
        });
        await waitForSettledQueueTurn();

        expect(shutdownSettled).toBe(false);
        expect(existsSync(`${targetPath}.tmp`)).toBe(true);

        replaceGate.resolve(undefined);
        await expect(resultPromise).resolves.toMatchObject({
            type: 'result',
            path: targetPath,
        });
        await shutdownPromise;

        expect(shutdownSettled).toBe(true);
        expect(readFileSyncUtf8(targetPath)).toBe('new-pdf');
        expect(existsSync(`${targetPath}.tmp`)).toBe(false);
    });

    it('refreshes the original save base after streamed Save to original syncs the working copy', async () => {
        const workingPath = join(tempRoot, 'refresh-working.pdf');
        const originalPath = join(tempRoot, 'refresh-original.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});

        const result = await runSaveToOriginalSession({
            workingPath,
            bytes: Buffer.from('new-pdf'),
        });

        expect(result).toMatchObject({
            type: 'result',
            path: originalPath,
            validation: { isValid: true },
        });
        expect(readFileSyncUtf8(originalPath)).toBe('new-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('new-pdf');
        expect(mocks.optimizeLargePdfForSave).toHaveBeenCalledWith(`${originalPath}.tmp`);
        expect(
            firstInvocationOrder(mocks.optimizeLargePdfForSave),
        ).toBeLessThan(firstInvocationOrder(mocks.atomicReplace));
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(firstInvocationOrder(mocks.copyFileCopyOnWrite))
            .toBeLessThan(firstInvocationOrder(mocks.refreshWorkingCopyOriginalFileExpectation));
    });

    it('rejects Save As before opening a temp stream when the sender does not own the working copy', async () => {
        const workingPath = join(tempRoot, 'foreign-working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(false);

        const sender = new FakeSender();
        const { beginSerializedPdfSaveAs } = await importSerializedPdfPersistence();

        await expect(beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            128,
            targetPath,
        )).rejects.toThrow('Working copy path is not managed');

        expect(mocks.makeSiblingTempPath).not.toHaveBeenCalled();
        expect(existsSync(`${targetPath}.tmp`)).toBe(false);
    });

    it('routes Save As working-copy replacement through the shared mutation queue', async () => {
        const workingPath = join(tempRoot, 'queued-working.pdf');
        const targetPath = join(tempRoot, 'queued-saved.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');
        const queuedMutation = deferred<undefined>();
        const { enqueueWorkingCopyMutation } = await importWorkingCopyMutationQueue();
        const blockingMutation = enqueueWorkingCopyMutation(workingPath, () => queuedMutation.promise);

        const resultPromise = runSaveAsSession({
            workingPath,
            targetPath,
            bytes: Buffer.from('new-pdf'),
        });
        await waitForSettledQueueTurn();

        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(readFileSyncUtf8(targetPath)).toBe('old-target');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();

        queuedMutation.resolve(undefined);
        await blockingMutation;
        await expect(resultPromise).resolves.toMatchObject({
            type: 'result',
            path: targetPath,
            validation: { isValid: true },
        });
        expect(readFileSyncUtf8(workingPath)).toBe('new-pdf');
        expect(readFileSyncUtf8(targetPath)).toBe('new-pdf');
    });

    it('preserves the Save As target when working-copy setup fails before streaming starts', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');
        mocks.ensureWorkingCopyDirectory.mockRejectedValue(new Error('working copy unavailable'));

        const sender = new FakeSender();
        const { beginSerializedPdfSaveAs } = await importSerializedPdfPersistence();

        await expect(beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            128,
            targetPath,
        )).rejects.toThrow('working copy unavailable');
        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(readFileSyncUtf8(targetPath)).toBe('old-target');
        expect(mocks.makeSiblingTempPath).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.setWorkingCopyOriginalPath).not.toHaveBeenCalled();
        expect(mocks.allowOpenPath).not.toHaveBeenCalled();
        expect(mocks.addRecentFile).not.toHaveBeenCalled();
        expect(mocks.updateRecentFilesMenu).not.toHaveBeenCalled();
    });

    it('acknowledges each streamed chunk after writing it to the temp file', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp`;
        const sender = new FakeSender();
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            4,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        expect(beginResult).toMatchObject({
            sessionId: expect.any(String),
            protocolVersion: 1,
            maxChunkBytes: 8 * 1024 * 1024,
            maxInFlightChunks: 2,
            maxTotalBytes: expect.any(Number),
            ackTimeoutMs: expect.any(Number),
            resultTimeoutMs: expect.any(Number),
        });

        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);

        port.emit('message', {data: {
            type: 'chunk',
            seq: 0,
            bytes: Buffer.from('%PDF'),
        }});

        await expect(port.nextMessage(message => isPortMessage(message, 'ack'))).resolves.toMatchObject({
            type: 'ack',
            seq: 0,
            receivedBytes: 4,
        });
        expect(readFileSyncUtf8(tempPath)).toBe('%PDF');

        port.close();
        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
    });

    it('accepts Electron MessagePortMain message events with transferred-port metadata', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'electron-message-event.pdf');
        const tempPath = `${targetPath}.tmp`;
        const sender = new FakeSender();
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            4,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);
        const resultPromise = port.nextResult();

        port.emit('message', {
            data: {
                type: 'chunk',
                seq: 0,
                bytes: Buffer.from('%PDF'),
            },
            ports: [],
        });

        await expect(port.nextMessage(message => isPortMessage(message, 'ack'))).resolves.toMatchObject({
            type: 'ack',
            seq: 0,
            receivedBytes: 4,
        });
        expect(readFileSyncUtf8(tempPath)).toBe('%PDF');

        port.emit('message', {
            data: {type: 'complete'},
            ports: [],
        });
        await expect(resultPromise).resolves.toMatchObject({type: 'result'});
        expect(readFileSyncUtf8(targetPath)).toBe('%PDF');
        expect(existsSync(tempPath)).toBe(false);
    });

    it('accepts deeply nested MessagePortMain message events from Electron payload wrappers', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'nested-electron-message-event.pdf');
        const tempPath = `${targetPath}.tmp`;
        const sender = new FakeSender();
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            4,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);
        const resultPromise = port.nextResult();

        port.emit('message', wrapMessageEventPayload({
            type: 'chunk',
            seq: 0,
            bytes: Buffer.from('%PDF'),
        }, 8));

        await expect(port.nextMessage(message => isPortMessage(message, 'ack'))).resolves.toMatchObject({
            type: 'ack',
            seq: 0,
            receivedBytes: 4,
        });
        expect(readFileSyncUtf8(tempPath)).toBe('%PDF');

        port.emit('message', wrapMessageEventPayload({type: 'complete'}, 8));
        await expect(resultPromise).resolves.toMatchObject({type: 'result'});
        expect(readFileSyncUtf8(targetPath)).toBe('%PDF');
        expect(existsSync(tempPath)).toBe(false);
    });

    it('rejects cyclic MessagePortMain event wrappers without recursive listener failure', async () => {
        const targetPath = join(tempRoot, 'cyclic-message-event.pdf');
        const tempPath = `${targetPath}.tmp`;
        const sender = new FakeSender();
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            4,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);
        const messageEvent: {
            data: unknown;
            ports: unknown[];
        } = {
            data: null,
            ports: [],
        };
        messageEvent.data = messageEvent;

        port.emit('message', messageEvent);

        await expect(port.nextMessage(message => isPortMessage(message, 'error'))).resolves.toMatchObject({
            type: 'error',
            code: 'PROTOCOL_ERROR',
            phase: 'streaming',
            retryable: false,
            expected: false,
            error: expect.stringContaining('Unknown PDF persistence message (keys=data,ports)'),
        });
        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
    });

    it('cleans an open Save As session when the sender is destroyed before streaming starts', async () => {
        const targetPath = join(tempRoot, 'destroyed-sender.pdf');
        const tempPath = `${targetPath}.tmp`;
        const sender = new FakeSender(73);
        const removeListenerSpy = vi.spyOn(sender, 'removeListener');
        const { beginSerializedPdfSaveAs } = await importSerializedPdfPersistence();

        await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            128,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );

        expect(existsSync(tempPath)).toBe(true);

        sender.emit('destroyed');

        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
        expect(removeListenerSpy).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(removeListenerSpy).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    });

    it('cleans an open Save As session when the sender render process is gone before streaming starts', async () => {
        const targetPath = join(tempRoot, 'gone-renderer.pdf');
        const tempPath = `${targetPath}.tmp`;
        const sender = new FakeSender(74);
        const removeListenerSpy = vi.spyOn(sender, 'removeListener');
        const { beginSerializedPdfSaveAs } = await importSerializedPdfPersistence();

        await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            128,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );

        expect(existsSync(tempPath)).toBe(true);

        sender.emit('render-process-gone');

        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
        expect(removeListenerSpy).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(removeListenerSpy).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    });

    it('cleans an open Save As session on non-in-place main-frame navigation before streaming starts', async () => {
        const targetPath = join(tempRoot, 'navigated-renderer.pdf');
        const tempPath = `${targetPath}.tmp`;
        const sender = new FakeSender(75);
        const removeListenerSpy = vi.spyOn(sender, 'removeListener');
        const { beginSerializedPdfSaveAs } = await importSerializedPdfPersistence();

        await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            128,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );

        expect(existsSync(tempPath)).toBe(true);

        sender.emit('did-start-navigation', {}, 'https://example.invalid/', false, true);

        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
        expect(removeListenerSpy).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(removeListenerSpy).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
        expect(removeListenerSpy).toHaveBeenCalledWith('did-start-navigation', expect.any(Function));
    });

    it('rejects new streams above the per-sender active session limit', async () => {
        const sender = new FakeSender(80);
        const { beginSerializedPdfSaveAs } = await importSerializedPdfPersistence();
        const targetPaths = Array.from({length: 4}, (_, index) => join(tempRoot, `limited-${index}.pdf`));

        for (const targetPath of targetPaths) {
            await expect(beginSerializedPdfSaveAs(
                createInvokeEvent(sender),
                join(tempRoot, 'working.pdf'),
                128,
                targetPath,
                undefined,
                SERIALIZED_TEST_REVISION_OPTIONS,
            )).resolves.toMatchObject({sessionId: expect.any(String)});
        }

        await expect(beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            128,
            join(tempRoot, 'limited-overflow.pdf'),
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        )).rejects.toThrow('Too many active PDF persistence streams');

        sender.emit('destroyed');
        await waitForCondition(() => {
            for (const targetPath of targetPaths) {
                expect(existsSync(`${targetPath}.tmp`)).toBe(false);
            }
        });
    });

    it('rejects duplicate MessagePort attachment for a serialized PDF session', async () => {
        const targetPath = join(tempRoot, 'duplicate-port.pdf');
        const tempPath = `${targetPath}.tmp`;
        const sender = new FakeSender(81);
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            128,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);

        expect(() => attachSerializedPdfPersistencePort({
            sender,
            ports: [new FakeMessagePort()],
        } as never, beginResult.sessionId)).toThrow('PDF persistence MessagePort is already attached');

        port.close();
        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
    });

    it('rejects serialized PDF chunks larger than the protocol chunk budget', async () => {
        const targetPath = join(tempRoot, 'oversized-chunk.pdf');
        const tempPath = `${targetPath}.tmp`;
        const sender = new FakeSender(82);
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            (8 * 1024 * 1024) + 1,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);

        port.emit('message', {data: {
            type: 'chunk',
            seq: 0,
            bytes: new Uint8Array((8 * 1024 * 1024) + 1),
        }});

        await expect(port.nextMessage(message => isPortMessage(message, 'error'))).resolves.toMatchObject({
            type: 'error',
            code: 'PROTOCOL_ERROR',
            phase: 'streaming',
            retryable: false,
            expected: false,
            seq: 0,
            error: expect.stringContaining('PDF persistence chunk exceeds maximum size'),
        });
        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
    });
});

interface ISerializedPersistenceTestRevisionOptions { expectedDocumentRevisionToken: string }

async function runSaveAsSession(options: {
    workingPath: string;
    targetPath: string;
    bytes: Uint8Array;
    options?: { optimizeLossless?: boolean };
    serializedSaveOptions?: ISerializedPersistenceTestRevisionOptions;
}) {
    const {
        attachSerializedPdfPersistencePort,
        beginSerializedPdfSaveAs,
    } = await importSerializedPdfPersistence();
    const sender = new FakeSender();
    const beginResult = await beginSerializedPdfSaveAs(
        createInvokeEvent(sender),
        options.workingPath,
        options.bytes.byteLength,
        options.targetPath,
        options.options,
        options.serializedSaveOptions ?? SERIALIZED_TEST_REVISION_OPTIONS,
    );
    const port = new FakeMessagePort();
    const resultPromise = port.nextResult();

    attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);

    port.emit('message', {data: {
        type: 'chunk',
        seq: 0,
        bytes: options.bytes,
    }});
    port.emit('message', {data: {type: 'complete'}});

    return resultPromise;
}

async function runSaveToOriginalSession(options: {
    workingPath: string;
    bytes: Uint8Array;
    serializedSaveOptions?: ISerializedPersistenceTestRevisionOptions;
}) {
    const {
        attachSerializedPdfPersistencePort,
        beginSerializedPdfSaveToOriginal,
    } = await importSerializedPdfPersistence();
    const sender = new FakeSender();
    const beginResult = await beginSerializedPdfSaveToOriginal(
        createInvokeEvent(sender),
        options.workingPath,
        options.bytes.byteLength,
        options.serializedSaveOptions ?? SERIALIZED_TEST_REVISION_OPTIONS,
    );
    const port = new FakeMessagePort();
    const resultPromise = port.nextResult();

    attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);

    port.emit('message', {data: {
        type: 'chunk',
        seq: 0,
        bytes: options.bytes,
    }});
    port.emit('message', {data: {type: 'complete'}});

    return resultPromise;
}

class FakeMessagePort extends EventEmitter {
    private readonly postedMessages: unknown[] = [];

    start() {
        return undefined;
    }

    postMessage(message: unknown) {
        this.postedMessages.push(message);
        this.emit('posted-message', message);
    }

    close() {
        this.emit('close');
    }

    nextResult() {
        return this.nextMessage(isTerminalPortMessage);
    }

    nextMessage(predicate: (message: unknown) => boolean) {
        return new Promise<unknown>((resolve) => {
            const existingResult = this.postedMessages.find(predicate);
            if (existingResult) {
                resolve(existingResult);
                return;
            }

            this.on('posted-message', (message) => {
                if (predicate(message)) {
                    resolve(message);
                }
            });
        });
    }
}

function isPortMessage(message: unknown, type: string) {
    return Boolean(
        message
        && typeof message === 'object'
        && 'type' in message
        && message.type === type,
    );
}

function isTerminalPortMessage(message: unknown) {
    return Boolean(
        message
        && typeof message === 'object'
        && 'type' in message
        && (message.type === 'result' || message.type === 'error'),
    );
}

function wrapMessageEventPayload(payload: unknown, depth: number) {
    let current = payload;
    for (let index = 0; index < depth; index += 1) {
        current = {
            data: current,
            ports: [],
        };
    }
    return current;
}

function readFileSyncUtf8(path: string) {
    return readFileSync(path, 'utf8');
}

async function waitForCondition(assertion: () => void) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await delay(10);
        }
    }

    throw lastError;
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
