import { EventEmitter } from 'node:events';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

class MockStdin extends EventEmitter {
    public end = vi.fn((_buffer: Buffer, callback?: (error?: Error | null) => void) => {
        this.endCallback = callback;
    });

    public endCallback: ((error?: Error | null) => void) | undefined;
}

class MockChildProcess extends EventEmitter {
    public stdout = new EventEmitter();
    public stderr = new EventEmitter();
    public stdin: MockStdin | undefined;
    public kill = vi.fn((_signal: string) => true);
}

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    ensureTessdataLanguages: vi.fn(),
    getOcrPaths: vi.fn(),
    resolveTesseractLanguageConfig: vi.fn(),
}));

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('@electron/ocr/language-models', () => ({ensureTessdataLanguages: mocks.ensureTessdataLanguages}));
vi.mock('@electron/ocr/paths', () => ({getOcrPaths: mocks.getOcrPaths}));
vi.mock('@electron/ocr/tesseract-language-config', () => ({resolveTesseractLanguageConfig: mocks.resolveTesseractLanguageConfig}));

describe('runOcr setup failure cleanup', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();

        mocks.ensureTessdataLanguages.mockResolvedValue(undefined);
        mocks.getOcrPaths.mockReturnValue({
            binary: '/mock/tesseract',
            tessdata: '/mock/tessdata',
        });
        mocks.resolveTesseractLanguageConfig.mockReturnValue({
            orderedLanguages: ['eng'],
            extraConfigArgs: [],
        });
    });

    it('kills the child immediately when stdin is unavailable', async () => {
        const child = new MockChildProcess();
        child.stdin = undefined;
        mocks.spawn.mockReturnValue(child);

        const { runOcr } = await import('@electron/ocr/tesseract');
        const result = await runOcr(Buffer.from('image'), ['eng']);

        expect(result).toEqual({
            success: false,
            text: '',
            error: 'Tesseract stdin is unavailable',
        });
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('kills the child immediately when stdin emits an error', async () => {
        const child = new MockChildProcess();
        const stdin = new MockStdin();
        child.stdin = stdin;
        mocks.spawn.mockReturnValue(child);

        const { runOcr } = await import('@electron/ocr/tesseract');
        const resultPromise = runOcr(Buffer.from('image'), ['eng']);
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalledTimes(1);
        });

        stdin.emit('error', new Error('broken pipe'));

        await expect(resultPromise).resolves.toEqual({
            success: false,
            text: '',
            error: 'broken pipe',
        });
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
});
