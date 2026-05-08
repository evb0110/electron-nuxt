import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const workerState: { mode: 'runtime-error' | 'startup-error' | 'success' } = { mode: 'startup-error' };
    const workerCtor = vi.fn();
    const loggerWarn = vi.fn();
    const readFile = vi.fn(async () => new Uint8Array([
        1,
        2,
        3,
    ]));
    const stat = vi.fn(async () => ({
        isFile: () => true,
        size: 1024,
    }));

    const addPage = vi.fn();
    const copyPages = vi.fn(async () => [{}]);
    const save = vi.fn(async () => new Uint8Array([
        9,
        9,
        9,
    ]));
    const create = vi.fn(async () => ({
        addPage,
        copyPages,
        save,
        embedPng: vi.fn(),
        embedJpg: vi.fn(),
    }));
    const load = vi.fn(async () => ({ getPageIndices: () => [0] }));

    return {
        workerState,
        workerCtor,
        loggerWarn,
        readFile,
        stat,
        create,
        load,
    };
});

vi.mock('worker_threads', () => ({Worker: class {
    private readonly onceHandlers = new Map<string, Set<(arg: unknown) => void>>();

    private readonly onHandlers = new Map<string, Set<(arg: unknown) => void>>();

    constructor(script: string, options: unknown) {
        mocks.workerCtor(script, options);
        queueMicrotask(() => {
            switch (mocks.workerState.mode) {
                case 'startup-error':
                    this.emit('error', new Error('Cannot find package pdf-lib from [eval1]'));
                    return;
                case 'runtime-error':
                    this.emit('online', undefined);
                    this.emit('error', new Error('worker ran out of memory'));
                    return;
                case 'success':
                    this.emit('online', undefined);
                    this.emit('message', {
                        type: 'result',
                        ok: true,
                        data: new Uint8Array([
                            7,
                            7,
                        ]),
                    });
                    return;
                default:
                    return;
            }
        });
    }

    on(event: string, callback: (arg: unknown) => void) {
        const handlers = this.onHandlers.get(event) ?? new Set();
        handlers.add(callback);
        this.onHandlers.set(event, handlers);
        return this;
    }

    once(event: string, callback: (arg: unknown) => void) {
        const handlers = this.onceHandlers.get(event) ?? new Set();
        handlers.add(callback);
        this.onceHandlers.set(event, handlers);
        return this;
    }

    removeAllListeners(event?: string) {
        if (event) {
            this.onceHandlers.delete(event);
            this.onHandlers.delete(event);
            return this;
        }

        this.onceHandlers.clear();
        this.onHandlers.clear();
        return this;
    }

    terminate() {
        return Promise.resolve(0);
    }

    private emit(event: string, payload: unknown) {
        const onHandlers = [...(this.onHandlers.get(event) ?? [])];
        for (const handler of onHandlers) {
            handler(payload);
        }

        const onceHandlers = [...(this.onceHandlers.get(event) ?? [])];
        this.onceHandlers.delete(event);
        for (const handler of onceHandlers) {
            handler(payload);
        }
    }
}}));

vi.mock('fs/promises', () => ({
    readFile: mocks.readFile,
    stat: mocks.stat,
}));

vi.mock('pdf-lib', () => ({PDFDocument: {
    create: mocks.create,
    load: mocks.load,
}}));

vi.mock('electron', () => ({nativeImage: {createFromPath: vi.fn(() => ({
    isEmpty: () => true,
    toPNG: () => new Uint8Array(),
}))}}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
})}));

const { createPdfFromInputPaths } =
    await import('@electron/image/pdf-conversion');

describe('createPdfFromInputPaths worker fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workerState.mode = 'startup-error';
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 1024,
        });
    });

    it('falls back to in-process conversion when worker startup fails', async () => {
        const result = await createPdfFromInputPaths(['/tmp/input.pdf']);

        expect(Array.from(result)).toEqual([
            9,
            9,
            9,
        ]);
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        const workerScript = mocks.workerCtor.mock.calls[0]?.[0] as string;
        const workerOptions = mocks.workerCtor.mock.calls[0]?.[1] as {
            eval?: boolean;
            workerData?: { inputPaths?: string[] };
        };
        expect(workerScript).toContain('pdf-combine-worker');
        expect(workerOptions.eval).toBeUndefined();
        expect(workerOptions.workerData?.inputPaths).toEqual(['/tmp/input.pdf']);
        expect(mocks.create).toHaveBeenCalledTimes(1);
        expect(mocks.load).toHaveBeenCalledTimes(1);
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('does not fall back to in-process conversion after runtime worker failure', async () => {
        mocks.workerState.mode = 'runtime-error';

        await expect(createPdfFromInputPaths(['/tmp/input.pdf']))
            .rejects
            .toThrow('worker ran out of memory');

        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('returns worker result when worker combine succeeds', async () => {
        mocks.workerState.mode = 'success';

        const result = await createPdfFromInputPaths(['/tmp/input.pdf']);

        expect(Array.from(result)).toEqual([
            7,
            7,
        ]);
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).not.toHaveBeenCalled();
    });

    it('falls back to in-process conversion for large worker startup failures', async () => {
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 32 * 1024 * 1024,
        });

        const result = await createPdfFromInputPaths(['/tmp/input.pdf']);

        expect(Array.from(result)).toEqual([
            9,
            9,
            9,
        ]);
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.create).toHaveBeenCalledTimes(1);
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('keeps worker combine path for worker-safe image inputs', async () => {
        mocks.workerState.mode = 'success';

        const inputPaths = [
            '/tmp/input.png',
            '/tmp/input.jpg',
            '/tmp/input.tiff',
        ];
        const result = await createPdfFromInputPaths(inputPaths);

        expect(Array.from(result)).toEqual([
            7,
            7,
        ]);
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        const workerOptions = mocks.workerCtor.mock.calls[0]?.[1] as {workerData?: { inputPaths?: string[] };};
        expect(workerOptions.workerData?.inputPaths).toEqual(inputPaths);
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).not.toHaveBeenCalled();
    });
});
