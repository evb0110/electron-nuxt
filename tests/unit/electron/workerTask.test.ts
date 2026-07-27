import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted<{
    existsSync: ReturnType<typeof vi.fn<() => boolean>>;
    workerCtor: ReturnType<typeof vi.fn<(workerPath: string, options: unknown) => void>>;
    workerRecords: Array<{
        emit: (event: string, payload: unknown) => void;
        postMessageCalls: unknown[];
    }>;
    throwConstructorError: boolean;
    nextMessage: unknown | null;
}>(() => ({
    existsSync: vi.fn(() => true),
    workerCtor: vi.fn(),
    workerRecords: [],
    throwConstructorError: true,
    nextMessage: null,
}));

vi.mock('fs', () => ({existsSync: mocks.existsSync}));
vi.mock('worker_threads', () => ({Worker: class {
    private readonly onceHandlers = new Map<string, Array<(payload: unknown) => void>>();
    private readonly onHandlers = new Map<string, Array<(payload: unknown) => void>>();
    private readonly postMessageCalls: unknown[] = [];

    constructor(workerPath: string, options: unknown) {
        mocks.workerCtor(workerPath, options);
        if (mocks.throwConstructorError) {
            throw new Error('constructor failed');
        }
        mocks.workerRecords.push({
            emit: (event: string, payload: unknown) => {
                this.emit(event, payload);
            },
            postMessageCalls: this.postMessageCalls,
        });
        void Promise.resolve().then(() => {
            this.emit('online', undefined);
            if (mocks.nextMessage !== null) {
                this.emit('message', mocks.nextMessage);
            }
        });
    }

    once(event: string, handler: (payload: unknown) => void) {
        const handlers = this.onceHandlers.get(event) ?? [];
        handlers.push(handler);
        this.onceHandlers.set(event, handlers);
        return this;
    }

    on(event: string, handler: (payload: unknown) => void) {
        const handlers = this.onHandlers.get(event) ?? [];
        handlers.push(handler);
        this.onHandlers.set(event, handlers);
        return this;
    }

    removeAllListeners(event: string) {
        this.onceHandlers.delete(event);
        this.onHandlers.delete(event);
        return this;
    }

    removeListener(event: string, handler: (payload: unknown) => void) {
        this.onceHandlers.set(event, (this.onceHandlers.get(event) ?? []).filter(item => item !== handler));
        this.onHandlers.set(event, (this.onHandlers.get(event) ?? []).filter(item => item !== handler));
        return this;
    }

    postMessage(message: unknown) {
        this.postMessageCalls.push(message);
        return undefined;
    }

    private emit(event: string, payload: unknown) {
        const persistentHandlers = this.onHandlers.get(event) ?? [];
        for (const handler of persistentHandlers) {
            handler(payload);
        }
        const onceHandlers = this.onceHandlers.get(event) ?? [];
        this.onceHandlers.delete(event);
        for (const handler of onceHandlers) {
            handler(payload);
        }
    }

    terminate() {
        return Promise.resolve(0);
    }
}}));

describe('workerTask', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.existsSync.mockReturnValue(true);
        mocks.throwConstructorError = true;
        mocks.nextMessage = null;
        mocks.workerRecords.length = 0;
    });

    it('normalizes streaming worker constructor errors as startup errors', async () => {
        const { startStreamingWorkerTask } = await import('@electron/utils/workerTask');

        expect(() => startStreamingWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createStartupError: message => new Error(`startup: ${message}`),
            createWorkerExitError: code => new Error(`exit: ${code}`),
        })).toThrow('startup: constructor failed');
    });

    it('keeps missing streaming worker paths on the startup error path', async () => {
        mocks.existsSync.mockReturnValue(false);
        const { startStreamingWorkerTask } = await import('@electron/utils/workerTask');

        expect(() => startStreamingWorkerTask({
            workerPath: '/tmp/missing-worker.js',
            workerData: null,
            invalidPayloadMessage: 'invalid payload',
            createStartupError: message => new Error(`startup: ${message}`),
            createWorkerExitError: code => new Error(`exit: ${code}`),
        })).toThrow('startup: Worker unavailable at path: /tmp/missing-worker.js');
        expect(mocks.workerCtor).not.toHaveBeenCalled();
    });

    it('rejects already aborted streaming tasks before constructing a worker', async () => {
        const abortController = new AbortController();
        const abortReason = new Error('stream canceled before start');
        abortController.abort(abortReason);
        const { startStreamingWorkerTask } = await import('@electron/utils/workerTask');

        expect(() => startStreamingWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createStartupError: message => new Error(`startup: ${message}`),
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
        })).toThrow(abortReason);
        expect(mocks.workerCtor).not.toHaveBeenCalled();
    });

    it('rejects already aborted result tasks before constructing a worker', async () => {
        const abortController = new AbortController();
        const abortReason = new Error('canceled before start');
        abortController.abort(abortReason);
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        await expect(runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
        })).rejects.toBe(abortReason);
        expect(mocks.workerCtor).not.toHaveBeenCalled();
    });

    it('preserves structured worker task error frames', async () => {
        mocks.throwConstructorError = false;
        mocks.nextMessage = {
            type: 'result',
            ok: false,
            error: 'Crop worker canceled',
            errorFrame: {
                message: 'Crop worker canceled',
                name: 'AbortError',
                code: 'ABORT_ERR',
                canceled: true,
                retryable: false,
                source: 'page-ops:crop-worker',
            },
        };
        const {
            runResultWorkerTask,
            WorkerTaskError,
        } = await import('@electron/utils/workerTask');

        try {
            await runResultWorkerTask({
                workerPath: '/tmp/worker.js',
                workerData: { ok: true },
                invalidPayloadMessage: 'invalid payload',
                createWorkerExitError: code => new Error(`exit: ${code}`),
            });
            throw new Error('Expected worker task to reject');
        } catch (error) {
            expect(error).toBeInstanceOf(WorkerTaskError);
            expect(error).toMatchObject({
                message: 'Crop worker canceled',
                name: 'AbortError',
                code: 'ABORT_ERR',
                canceled: true,
                retryable: false,
                source: 'page-ops:crop-worker',
            });
        }
    });

    it('passes opt-in resource limits to result workers', async () => {
        mocks.throwConstructorError = false;
        mocks.nextMessage = {
            type: 'result',
            ok: true,
            data: 'ok',
        };
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        await expect(runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            resourceLimits: {
                maxOldGenerationSizeMb: 256,
                maxYoungGenerationSizeMb: 32,
                stackSizeMb: 8,
            },
        })).resolves.toBe('ok');

        expect(mocks.workerCtor).toHaveBeenCalledWith('/tmp/worker.js', {
            workerData: { ok: true },
            resourceLimits: {
                maxOldGenerationSizeMb: 256,
                maxYoungGenerationSizeMb: 32,
                stackSizeMb: 8,
            },
        });
    });

    it('preserves the pending abort reason when a cooperatively canceled worker errors', async () => {
        mocks.throwConstructorError = false;
        const abortController = new AbortController();
        const abortReason = new Error('user canceled task');
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: reason => ({
                type: 'cancel',
                reason,
            }),
        });

        await Promise.resolve();
        abortController.abort(abortReason);
        expect(mocks.workerRecords[0]?.postMessageCalls).toContainEqual({
            type: 'cancel',
            reason: 'abort',
        });

        mocks.workerRecords[0]?.emit('error', new Error('generic worker failure'));

        await expect(taskPromise).rejects.toBe(abortReason);
    });

    it('preserves the pending abort reason when a cooperatively canceled worker exits', async () => {
        mocks.throwConstructorError = false;
        const abortController = new AbortController();
        const abortReason = new Error('navigation canceled task');
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: reason => ({
                type: 'cancel',
                reason,
            }),
        });

        await Promise.resolve();
        abortController.abort(abortReason);

        mocks.workerRecords[0]?.emit('exit', 1);

        await expect(taskPromise).rejects.toBe(abortReason);
    });
});
