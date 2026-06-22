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
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    validatePdfFile: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn(),
    getWorkingCopyOriginalFileExpectation: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn(),
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
    setWorkingCopyOriginalPath: vi.fn<(workingPath: string, originalPath: string, senderId?: number) => void>(),
    allowOpenPath: vi.fn(),
    addRecentFile: vi.fn(),
    updateRecentFilesMenu: vi.fn(),
    optimizePdfForSaveAs: vi.fn(),
    copyFileCopyOnWrite: vi.fn(),
}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/features/documents/main/pdfConformance', () => ({validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args)}));
vi.mock('@electron/features/documents/main/pdfSaveAsOptimization', () => ({ optimizePdfForSaveAs: (...args: unknown[]) => mocks.optimizePdfForSaveAs(...args) }));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    getWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.getWorkingCopyOriginalFileExpectation(...args),
    getWorkingCopyOriginalPath: (...args: unknown[]) => mocks.getWorkingCopyOriginalPath(...args),
    normalizePathForLookup: (path: string) => path.trim(),
    refreshWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.refreshWorkingCopyOriginalFileExpectation(...args),
    setWorkingCopyOriginalPath: (...args: [string, string, number?]) => mocks.setWorkingCopyOriginalPath(...args),
}));
vi.mock('@electron/file-access/isAllowedOriginalSavePath', () => ({isAllowedOriginalSavePath: vi.fn(() => true)}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: [string, string]) => mocks.copyFileCopyOnWrite(...args)}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args)}));
vi.mock('@electron/recentFiles', () => ({addRecentFile: (...args: unknown[]) => mocks.addRecentFile(...args)}));
vi.mock('@electron/menu', () => ({updateRecentFilesMenu: (...args: unknown[]) => mocks.updateRecentFilesMenu(...args)}));

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
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(null);
        mocks.optimizePdfForSaveAs.mockResolvedValue(null);
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
            mocks.ensureWorkingCopyDirectory.mock.invocationCallOrder[0]!,
        ).toBeLessThan(mocks.makeSiblingTempPath.mock.invocationCallOrder[0]!);
        expect(
            mocks.ensureWorkingCopyDirectory.mock.invocationCallOrder[0]!,
        ).toBeLessThan(mocks.atomicReplace.mock.invocationCallOrder[0]!);
        expect(mocks.setWorkingCopyOriginalPath).toHaveBeenCalledWith(workingPath, targetPath, 42);
        expect(mocks.allowOpenPath).toHaveBeenCalledWith(targetPath, 42);
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
            mocks.optimizePdfForSaveAs.mock.invocationCallOrder[0]!,
        ).toBeLessThan(mocks.atomicReplace.mock.invocationCallOrder[0]!);
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
        const sender = new EventEmitter() as EventEmitter & { id: number };
        sender.id = 42;
        const { beginSerializedPdfSaveAs } = await import('@electron/features/documents/main/serializedPdfPersistence');

        const result = await beginSerializedPdfSaveAs(
            {sender} as never,
            workingPath,
            (512 * 1024 * 1024) + 1,
            targetPath,
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
        const sender = new EventEmitter() as EventEmitter & { id: number };
        sender.id = 42;
        const { beginSerializedPdfSaveAs } = await import('@electron/features/documents/main/serializedPdfPersistence');

        await expect(beginSerializedPdfSaveAs(
            {sender} as never,
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
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
    });

    it('returns committed success with a warning when streamed Save to original copy-back fails', async () => {
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
            path: originalPath,
            validation: {
                isValid: true,
                warnings: [expect.stringContaining('copy-back failed')],
            },
        });
        expect(readFileSyncUtf8(originalPath)).toBe('new-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
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
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.copyFileCopyOnWrite.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.refreshWorkingCopyOriginalFileExpectation.mock.invocationCallOrder[0]!);
    });

    it('rejects Save As before opening a temp stream when the sender does not own the working copy', async () => {
        const workingPath = join(tempRoot, 'foreign-working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(false);

        const sender = new EventEmitter() as EventEmitter & { id: number };
        sender.id = 42;
        const { beginSerializedPdfSaveAs } = await import('@electron/features/documents/main/serializedPdfPersistence');

        await expect(beginSerializedPdfSaveAs(
            {sender} as never,
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
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
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

        const sender = new EventEmitter() as EventEmitter & { id: number };
        sender.id = 42;
        const { beginSerializedPdfSaveAs } = await import('@electron/features/documents/main/serializedPdfPersistence');

        await expect(beginSerializedPdfSaveAs(
            {sender} as never,
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
        const sender = new EventEmitter() as EventEmitter & { id: number };
        sender.id = 42;
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await import('@electron/features/documents/main/serializedPdfPersistence');

        const beginResult = await beginSerializedPdfSaveAs(
            {sender} as never,
            workingPath,
            4,
            targetPath,
        );

        attachSerializedPdfPersistencePort({
            sender,
            ports: [port],
        } as never, beginResult.sessionId);

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

    it('cleans an open Save As session when the sender is destroyed before streaming starts', async () => {
        const targetPath = join(tempRoot, 'destroyed-sender.pdf');
        const tempPath = `${targetPath}.tmp`;
        const sender = new EventEmitter() as EventEmitter & { id: number };
        sender.id = 73;
        const removeListenerSpy = vi.spyOn(sender, 'removeListener');
        const { beginSerializedPdfSaveAs } = await import('@electron/features/documents/main/serializedPdfPersistence');

        await beginSerializedPdfSaveAs(
            {sender} as never,
            join(tempRoot, 'working.pdf'),
            128,
            targetPath,
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
        const sender = new EventEmitter() as EventEmitter & { id: number };
        sender.id = 74;
        const removeListenerSpy = vi.spyOn(sender, 'removeListener');
        const { beginSerializedPdfSaveAs } = await import('@electron/features/documents/main/serializedPdfPersistence');

        await beginSerializedPdfSaveAs(
            {sender} as never,
            join(tempRoot, 'working.pdf'),
            128,
            targetPath,
        );

        expect(existsSync(tempPath)).toBe(true);

        sender.emit('render-process-gone');

        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
        expect(removeListenerSpy).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(removeListenerSpy).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    });
});

async function runSaveAsSession(options: {
    workingPath: string;
    targetPath: string;
    bytes: Uint8Array;
    options?: { optimizeLossless?: boolean };
}) {
    const {
        attachSerializedPdfPersistencePort,
        beginSerializedPdfSaveAs,
    } = await import('@electron/features/documents/main/serializedPdfPersistence');
    const sender = new EventEmitter() as EventEmitter & { id: number };
    sender.id = 42;
    const beginResult = await beginSerializedPdfSaveAs(
        {sender} as never,
        options.workingPath,
        options.bytes.byteLength,
        options.targetPath,
        options.options,
    );
    const port = new FakeMessagePort();
    const resultPromise = port.nextResult();

    attachSerializedPdfPersistencePort({
        sender,
        ports: [port],
    } as never, beginResult.sessionId);

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
}) {
    const {
        attachSerializedPdfPersistencePort,
        beginSerializedPdfSaveToOriginal,
    } = await import('@electron/features/documents/main/serializedPdfPersistence');
    const sender = new EventEmitter() as EventEmitter & { id: number };
    sender.id = 42;
    const beginResult = await beginSerializedPdfSaveToOriginal(
        {sender} as never,
        options.workingPath,
        options.bytes.byteLength,
    );
    const port = new FakeMessagePort();
    const resultPromise = port.nextResult();

    attachSerializedPdfPersistencePort({
        sender,
        ports: [port],
    } as never, beginResult.sessionId);

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
