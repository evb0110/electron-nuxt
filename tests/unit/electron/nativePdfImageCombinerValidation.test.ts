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
        readFile: vi.fn(),
        rm: vi.fn(async () => undefined),
        spawn: vi.fn(),
        terminateDetachedChildProcess: vi.fn(async () => undefined),
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
    readFile: mocks.readFile,
    rm: mocks.rm,
    writeFile: mocks.writeFile,
}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: () => '/native/evb-pdf-image-combine'}));
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

    it('returns null and removes temp output when native bytes are not a PDF', async () => {
        mocks.readFile.mockResolvedValueOnce(Buffer.from('not a pdf'));
        const { tryCreatePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryCreatePdfWithNativeImageCombiner(['/tmp/input.png'])).resolves.toBeNull();

        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('produced invalid PDF output'));
        expect(mocks.rm).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/pdf-image-combine-test\/.+\.pdf$/u), { force: true });
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });
    });

    it('rejects successful file-backed native combines when output is malformed', async () => {
        mocks.readFile.mockResolvedValueOnce(Buffer.from(''));
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf')).resolves.toBe(false);

        expect(mocks.rm).toHaveBeenCalledWith('/tmp/output.pdf', { force: true });
    });

    it('removes file-backed native output when the native process fails', async () => {
        mocks.spawn.mockImplementationOnce(() => {
            const proc = new MockProcess();
            queueMicrotask(() => {
                proc.emit('close', 1);
            });
            return proc;
        });
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf')).resolves.toBe(false);

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
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });
    });

    it('accepts structurally plausible native PDF output', async () => {
        const validPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
        mocks.readFile.mockResolvedValueOnce(validPdf);
        const { tryCreatePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryCreatePdfWithNativeImageCombiner(['/tmp/input.png'])).resolves.toEqual(new Uint8Array(validPdf));
    });
});
