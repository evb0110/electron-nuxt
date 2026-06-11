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
    const writeFile = vi.fn(async () => undefined);
    const mkdtemp = vi.fn(async () => '/tmp/pdf-combine-djvu-test');
    const rm = vi.fn(async () => undefined);
    const stat = vi.fn(async () => ({
        isFile: () => true,
        size: 1024,
    }));
    const nativeAssembler = vi.fn(async (
        _inputPaths: string[],
        _options?: unknown,
    ) => null as Uint8Array | null);
    const nativeFileAssembler = vi.fn(async (
        _inputPaths: string[],
        _outputPath: string,
        _options?: unknown,
    ) => false);
    const getDjvuPageCount = vi.fn(async () => 2);
    const convertDjvuToPdfFile = vi.fn(async () => ({
        success: true,
        outputPath: '/tmp/pdf-combine-djvu-test/output.pdf',
        fileSize: 1024,
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
        writeFile,
        mkdtemp,
        rm,
        stat,
        nativeAssembler,
        nativeFileAssembler,
        getDjvuPageCount,
        convertDjvuToPdfFile,
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

    removeListener(event: string, callback: (arg: unknown) => void) {
        this.onceHandlers.get(event)?.delete(callback);
        this.onHandlers.get(event)?.delete(callback);
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
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    writeFile: mocks.writeFile,
}));

vi.mock('pdf-lib', () => ({PDFDocument: {
    create: mocks.create,
    load: mocks.load,
}}));

vi.mock('electron', () => ({nativeImage: {createFromPath: vi.fn(() => ({
    isEmpty: () => true,
    toPNG: () => new Uint8Array(),
}))}}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
})}));

vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({convertDjvuToPdfFile: mocks.convertDjvuToPdfFile}));
vi.mock('@electron/djvu/metadata', () => ({getDjvuPageCount: mocks.getDjvuPageCount}));

vi.mock('@electron/image/tryCreatePdfFromInputPathsNative', () => ({
    tryCreatePdfFromInputPathsNative: (
        inputPaths: string[],
        options?: unknown,
    ) => mocks.nativeAssembler(inputPaths, options),
    tryWritePdfFromInputPathsNative: (
        inputPaths: string[],
        outputPath: string,
        options?: unknown,
    ) => mocks.nativeFileAssembler(inputPaths, outputPath, options),
}));

const {
    createPdfFileFromInputPaths,
    createPdfFromInputPaths,
} =
    await import('@electron/image/pdfConversion');

describe('createPdfFromInputPaths worker fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workerState.mode = 'startup-error';
        mocks.mkdtemp.mockResolvedValue('/tmp/pdf-combine-djvu-test');
        mocks.rm.mockResolvedValue(undefined);
        mocks.convertDjvuToPdfFile.mockResolvedValue({
            success: true,
            outputPath: '/tmp/pdf-combine-djvu-test/output.pdf',
            fileSize: 1024,
        });
        mocks.getDjvuPageCount.mockResolvedValue(2);
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 1024,
        });
        mocks.nativeAssembler.mockResolvedValue(null);
        mocks.nativeFileAssembler.mockResolvedValue(false);
    });

    it('uses the native assembler before spawning the pdf-lib worker for mixed PDF and image inputs', async () => {
        const progress = vi.fn();
        const nativeBytes = new Uint8Array([
            6,
            6,
            6,
        ]);
        mocks.nativeAssembler.mockResolvedValueOnce(nativeBytes);

        const inputPaths = [
            '/tmp/input.pdf',
            '/tmp/photo.png',
            '/tmp/photo.jpg',
            '/tmp/scan.tiff',
        ];
        const result = await createPdfFromInputPaths(inputPaths, {onProgress: progress});

        expect(result).toBe(nativeBytes);
        expect(mocks.nativeAssembler).toHaveBeenCalledWith(inputPaths, {onProgress: progress});
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
    });

    it('writes oversized native-supported batches through the file-backed native assembler', async () => {
        const progress = vi.fn();
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 4 * 1024 * 1024 * 1024,
        });
        mocks.nativeFileAssembler.mockResolvedValueOnce(true);

        const result = await createPdfFileFromInputPaths(
            ['/tmp/huge.tiff'],
            '/tmp/output.pdf',
            {onProgress: progress},
        );

        expect(result).toBe('/tmp/output.pdf');
        expect(mocks.nativeFileAssembler).toHaveBeenCalledWith(
            ['/tmp/huge.tiff'],
            '/tmp/output.pdf',
            {onProgress: progress},
        );
        expect(mocks.nativeAssembler).not.toHaveBeenCalled();
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('does not fall back to memory combine when oversized file-backed native combine fails', async () => {
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 4 * 1024 * 1024 * 1024,
        });
        mocks.nativeFileAssembler.mockResolvedValueOnce(false);

        await expect(createPdfFileFromInputPaths(['/tmp/huge.tiff'], '/tmp/output.pdf'))
            .rejects
            .toThrow('Input file is too large to combine safely: /tmp/huge.tiff');

        expect(mocks.nativeAssembler).not.toHaveBeenCalled();
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('uses the memory combine fallback only for small file-backed jobs', async () => {
        mocks.workerState.mode = 'startup-error';

        const result = await createPdfFileFromInputPaths(['/tmp/input.pdf'], '/tmp/output.pdf');

        expect(result).toBe('/tmp/output.pdf');
        expect(mocks.nativeFileAssembler).toHaveBeenCalledWith(
            ['/tmp/input.pdf'],
            '/tmp/output.pdf',
            undefined,
        );
        expect(mocks.stat).toHaveBeenCalledTimes(1);
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.writeFile).toHaveBeenCalledWith('/tmp/output.pdf', new Uint8Array([
            9,
            9,
            9,
        ]));
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
        expect(workerScript).toContain('pdfCombineWorker');
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

    it('rejects large inputs instead of falling back to in-process conversion after worker startup failures', async () => {
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 32 * 1024 * 1024,
        });

        await expect(createPdfFromInputPaths(['/tmp/input.pdf']))
            .rejects
            .toThrow('Image combine worker startup failed and main-process fallback is disabled for inputs larger than 16MB');

        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.create).not.toHaveBeenCalled();
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

    it('converts DjVu inputs on the local combine path', async () => {
        const result = await createPdfFromInputPaths([
            '/tmp/input.pdf',
            '/tmp/scan.djvu',
        ]);

        expect(Array.from(result)).toEqual([
            9,
            9,
            9,
        ]);
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledWith(
            '/tmp/scan.djvu',
            expect.stringMatching(/^\/tmp\/pdf-combine-djvu-test\/.+\.pdf$/u),
            expect.stringMatching(/^pdf-combine-djvu-/u),
            {
                subsample: 1,
                pageCount: 2,
            },
        );
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-combine-djvu-test', {
            recursive: true,
            force: true,
        });
        expect(mocks.load).toHaveBeenCalledTimes(2);
    });
});
