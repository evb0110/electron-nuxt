import {EventEmitter} from 'node:events';
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
    getWorkingCopyOriginalPath: vi.fn(),
    setWorkingCopyOriginalPath: vi.fn<(workingPath: string, originalPath: string, senderId?: number) => void>(),
    allowOpenPath: vi.fn(),
    addRecentFile: vi.fn(),
    updateRecentFilesMenu: vi.fn(),
}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/features/documents/main/pdfConformance', () => ({validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args)}));
vi.mock('@electron/ipc/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/ipc/workingCopyStore', () => ({
    getWorkingCopyOriginalPath: (...args: unknown[]) => mocks.getWorkingCopyOriginalPath(...args),
    setWorkingCopyOriginalPath: (...args: [string, string, number?]) => mocks.setWorkingCopyOriginalPath(...args),
}));
vi.mock('@electron/ipc/workingCopyValidation', () => ({isAllowedOriginalSavePath: vi.fn(() => true)}));
vi.mock('@electron/ipc/openPathCapabilities', () => ({allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args)}));
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
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
            await unlink(sourcePath);
        });
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('prepares the Save As working copy before replacing the selected target', async () => {
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
        const { enqueueWorkingCopyMutation } = await import('@electron/ipc/workingCopyMutationQueue');
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
            await new Promise(resolve => setTimeout(resolve, 10));
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
    await new Promise(resolve => setTimeout(resolve, 20));
}
