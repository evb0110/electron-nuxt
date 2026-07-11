import { EventEmitter } from 'node:events';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        open: vi.fn(),
        openData: Buffer.from('%PDF-1.7\n%%EOF\n'),
        readFile: vi.fn(),
        rm: vi.fn(async () => undefined),
        spawn: vi.fn(),
        terminateDetachedChildProcess: vi.fn(async () => undefined),
        verifyNativeToolProtocol: vi.fn(async () => undefined),
        warn: vi.fn(),
        writeFile: vi.fn(async () => undefined),
    };
});

class MockProcess extends EventEmitter {
    readonly pid = 12345;

    readonly stdout = new EventEmitter();

    readonly stderr = new EventEmitter();

    readonly kill = vi.fn();
}

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('fs/promises', () => ({
    mkdtemp: vi.fn(async () => '/tmp/pdf-image-combine-test'),
    open: mocks.open,
    readFile: mocks.readFile,
    rm: mocks.rm,
    writeFile: mocks.writeFile,
}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: () => '/native/evb-pdf-image-combine'}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({verifyNativeToolProtocol: mocks.verifyNativeToolProtocol}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: object) => ({
        ...options,
        detached: true,
    }),
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: mocks.warn,
})}));

describe('native PDF image combiner output validation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('EVB_PDF_IMAGE_COMBINE_ENABLE', '1');
        mocks.openData = Buffer.from('%PDF-1.7\n%%EOF\n');
        mocks.readFile.mockReset();
        mocks.readFile.mockImplementation(async () => Buffer.from(mocks.openData));
        mocks.open.mockImplementation(async () => ({
            stat: vi.fn(async () => ({
                isFile: () => true,
                size: mocks.openData.byteLength,
            })),
            read: vi.fn(async (
                buffer: Buffer,
                offset: number,
                length: number,
                position: number,
            ) => {
                mocks.openData.copy(buffer, offset, position, position + length);
                return {
                    bytesRead: length,
                    buffer,
                };
            }),
            close: vi.fn(async () => undefined),
        }));
        mocks.spawn.mockImplementation(() => {
            const proc = new MockProcess();
            queueMicrotask(() => {
                proc.emit('close', 0);
            });
            return proc;
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('rejects when native bytes are not a PDF in enabled test mode', async () => {
        mocks.openData = Buffer.from('not a pdf');
        mocks.readFile.mockResolvedValueOnce(Buffer.from('not a pdf'));
        const { tryCreatePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryCreatePdfWithNativeImageCombiner(['/tmp/input.png']))
            .rejects.toThrow('Native image PDF combine fallback is not allowed in tests');

        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('produced invalid PDF output'));
        expect(mocks.rm).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/pdf-image-combine-test\/.+\.pdf$/u), { force: true });
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });
    });

    it('rejects successful file-backed native combines when output is malformed in enabled test mode', async () => {
        mocks.openData = Buffer.from('');
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf'))
            .rejects.toThrow('Native image PDF combine fallback is not allowed in tests');

        expect(mocks.rm).toHaveBeenCalledWith('/tmp/output.pdf', { force: true });
    });

    it('rejects when the native process fails in enabled test mode', async () => {
        mocks.spawn.mockImplementationOnce(() => {
            const proc = new MockProcess();
            queueMicrotask(() => {
                proc.emit('close', 1);
            });
            return proc;
        });
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf'))
            .rejects.toThrow('Native image PDF combine fallback is not allowed in tests');

        expect(mocks.rm).toHaveBeenCalledWith('/tmp/output.pdf', { force: true });
    });

    it('terminates the native process group and rejects when canceled', async () => {
        const proc = new MockProcess();
        const abortError = new Error('Canceled by test');
        abortError.name = 'AbortError';
        mocks.spawn.mockReturnValueOnce(proc);
        mocks.terminateDetachedChildProcess.mockImplementationOnce(async () => {
            proc.emit('close', null, 'SIGTERM');
        });
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const controller = new AbortController();

        const pending = tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf', {signal: controller.signal});
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        controller.abort(abortError);

        await expect(pending).rejects.toBe(abortError);
        expect(mocks.spawn).toHaveBeenCalledWith('/native/evb-pdf-image-combine', expect.any(Array), expect.objectContaining({detached: true}));
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
        expect(mocks.readFile).toHaveBeenCalledWith('/tmp/input.jpg');
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });
    });

    it('accepts structurally plausible native PDF output', async () => {
        const validPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
        mocks.openData = validPdf;
        mocks.readFile.mockResolvedValueOnce(validPdf);
        const { tryCreatePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryCreatePdfWithNativeImageCombiner(['/tmp/input.png'])).resolves.toEqual(new Uint8Array(validPdf));
        expect(mocks.verifyNativeToolProtocol).toHaveBeenCalledWith('/native/evb-pdf-image-combine', {});
        expect(mocks.verifyNativeToolProtocol.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.spawn.mock.invocationCallOrder[0]!);
    });

    it('validates file-backed native PDF output without reading the whole file into memory', async () => {
        mocks.openData = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf')).resolves.toBe(true);

        expect(mocks.readFile).toHaveBeenCalledWith('/tmp/input.jpg');
        expect(mocks.open).toHaveBeenCalledWith('/tmp/output.pdf', 'r');
    });

    it('rejects before spawning when protocol verification fails', async () => {
        mocks.verifyNativeToolProtocol.mockRejectedValueOnce(new Error('expected 1, got 99'));
        const { tryCreatePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryCreatePdfWithNativeImageCombiner(['/tmp/input.png'])).rejects.toThrow('expected 1, got 99');
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
});
