import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const workerState: { mode: 'malformed-result' | 'runtime-error' | 'startup-error' | 'success' } = {mode: 'startup-error'};
    const workerCtor = vi.fn();
    const loggerWarn = vi.fn();
    const runNativeToolCommand = vi.fn();
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
        runNativeToolCommand,
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
                case 'malformed-result':
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
                            canIncrementalSave: 'yes',
                            saveRestrictions: [],
                        },
                    });
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

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/native-tools/getNativeToolPaths', () => ({getNativeToolPaths: () => ({qpdf: '/mock/qpdf'})}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
})}));

const {
    analyzePdfConformanceFile,
    validatePdfFile,
} = await import('@electron/features/documents/main/pdfConformance');
const { analyzePdfConformanceFileDirect } = await import('@electron/features/documents/main/analyzePdfConformanceFileDirect');

describe('analyzePdfConformanceFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workerState.mode = 'startup-error';
        mocks.runNativeToolCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
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

    it('rejects malformed worker result payloads', async () => {
        mocks.workerState.mode = 'malformed-result';

        await expect(analyzePdfConformanceFile('/tmp/malformed-result.pdf'))
            .rejects
            .toThrow('PDF conformance worker returned an invalid payload');

        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });
});

describe('analyzePdfConformanceFileDirect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readFile.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        mocks.load.mockResolvedValue({
            catalog: { lookupMaybe: vi.fn(() => undefined) },
            isEncrypted: false,
        });
    });

    it('returns conservative save restrictions when structural parsing fails', async () => {
        mocks.readFile.mockResolvedValueOnce(Buffer.from(`
            <pdfaid:part>2</pdfaid:part>
            <pdfaid:conformance>b</pdfaid:conformance>
            /ByteRange [0 10 20 30]
            /Encrypt 42 0 R
        `, 'latin1'));
        mocks.load.mockRejectedValueOnce(new Error('parse failed'));

        const result = await analyzePdfConformanceFileDirect('/tmp/partial.pdf');

        expect(result).toEqual({
            isSigned: true,
            isEncrypted: true,
            isTagged: false,
            pdfaLevel: 'PDF/A-2B',
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: false,
            saveRestrictions: [
                'signed_original_requires_save_as',
                'encrypted_document_requires_preservation',
                'pdfa_preservation_required:PDF/A-2B',
                'incremental_save_not_supported',
            ],
        });
    });
});

describe('validatePdfFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.runNativeToolCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
        mocks.readFile.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        mocks.load.mockResolvedValue({
            catalog: { lookupMaybe: vi.fn(() => undefined) },
            isEncrypted: false,
        });
    });

    it('uses qpdf validation when qpdf completes', async () => {
        mocks.runNativeToolCommand.mockResolvedValueOnce({
            stdout: 'checking /tmp/input.pdf\nwarning: repaired xref',
            stderr: '',
            exitCode: 0,
        });

        const result = await validatePdfFile('/tmp/input.pdf');

        expect(result).toEqual({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: ['warning: repaired xref'],
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith('/mock/qpdf', [
            '--check',
            '/tmp/input.pdf',
        ], {
            timeoutMs: 30_000,
            allowedExitCodes: [
                0,
                3,
            ],
            commandLabel: 'qpdf(validate-pdf)',
        });
        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('accepts a qpdf timeout when structural fallback can load the PDF', async () => {
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('qpdf(validate-pdf) timed out after 30000ms'));

        const result = await validatePdfFile('/tmp/slow.pdf');

        expect(result).toEqual({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: ['qpdf validation timed out after 30000ms; fallback PDF structure validation succeeded.'],
        });
        expect(mocks.readFile).toHaveBeenCalledWith('/tmp/slow.pdf');
        expect(mocks.load).toHaveBeenCalledOnce();
        expect(mocks.loggerWarn).toHaveBeenCalledOnce();
    });

    it('keeps a qpdf timeout invalid when structural fallback cannot load the PDF', async () => {
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('qpdf(validate-pdf) timed out after 30000ms'));
        mocks.load.mockRejectedValueOnce(new Error('bad xref'));

        const result = await validatePdfFile('/tmp/broken.pdf');

        expect(result).toEqual({
            isValid: false,
            tool: 'qpdf',
            errors: ['qpdf(validate-pdf) timed out after 30000ms; fallback PDF structure validation failed: bad xref'],
            warnings: [],
        });
    });
});
