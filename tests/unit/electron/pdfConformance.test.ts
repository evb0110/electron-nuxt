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
    const load = vi.fn(async () => ({
        catalog: { lookupMaybe: vi.fn(() => undefined) },
        isEncrypted: false, 
    }));

    return {
        workerState,
        workerCtor,
        loggerWarn,
        readFile,
        stat,
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
                    this.emit('error', new Error('PDF worker missing'));
                    return;
                case 'runtime-error':
                    this.emit('online', undefined);
                    this.emit('error', new Error('worker crashed after startup'));
                    return;
                case 'success':
                    this.emit('online', undefined);
                    this.emit('message', {
                        type: 'result',
                        ok: true,
                        data: {
                            isSigned: false,
                            isEncrypted: false,
                            isTagged: false,
                            pdfaLevel: null,
                            hasAcroForm: false,
                            hasXfa: false,
                            canIncrementalSave: true,
                            saveRestrictions: [],
                        },
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

vi.mock('pdf-lib', () => {
    function MockPDFDict(this: unknown) {
        void this;
    }
    const MockPDFName = { of: (name: string) => name };

    return {
        PDFDict: MockPDFDict,
        PDFDocument: { load: mocks.load },
        PDFName: MockPDFName, 
    };
});

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }));

vi.mock('@electron/native-tools/exec', () => ({runNativeToolCommand: vi.fn()}));
vi.mock('@electron/native-tools/paths', () => ({getNativeToolPaths: () => ({qpdf: '/mock/qpdf'})}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
})}));

const { analyzePdfConformanceFile } = await import('@electron/features/documents/main/pdfConformance');

describe('analyzePdfConformanceFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workerState.mode = 'startup-error';
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 1024, 
        });
        mocks.load.mockResolvedValue({
            catalog: { lookupMaybe: vi.fn(() => undefined) },
            isEncrypted: false, 
        });
    });

    it('returns the worker result when the worker starts successfully', async () => {
        mocks.workerState.mode = 'success';

        const result = await analyzePdfConformanceFile('/tmp/input.pdf');

        expect(result).toEqual({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).not.toHaveBeenCalled();
    });

    it('surfaces startup failures without falling back to direct main-thread analysis', async () => {
        await expect(analyzePdfConformanceFile('/tmp/input.pdf'))
            .rejects
            .toThrow('PDF conformance worker failed before becoming ready: PDF worker missing');

        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('surfaces runtime worker failures without falling back to the main thread', async () => {
        mocks.workerState.mode = 'runtime-error';

        await expect(analyzePdfConformanceFile('/tmp/runtime-failure.pdf'))
            .rejects
            .toThrow('worker crashed after startup');

        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });
});
