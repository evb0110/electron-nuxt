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
vi.mock('@electron/ocr/languageModels', () => ({ensureTessdataLanguages: mocks.ensureTessdataLanguages}));
vi.mock('@electron/ocr/paths', () => ({getOcrPaths: mocks.getOcrPaths}));
vi.mock('@electron/ocr/tesseractLanguageConfig', () => ({resolveTesseractLanguageConfig: mocks.resolveTesseractLanguageConfig}));

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

    it('kills the child and resolves when the OCR signal aborts', async () => {
        const child = new MockChildProcess();
        const stdin = new MockStdin();
        child.stdin = stdin;
        mocks.spawn.mockReturnValue(child);
        const controller = new AbortController();

        const { runOcr } = await import('@electron/ocr/tesseract');
        const resultPromise = runOcr(Buffer.from('image'), ['eng'], {signal: controller.signal});
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalledTimes(1);
        });

        controller.abort();

        await expect(resultPromise).resolves.toEqual({
            success: false,
            text: '',
            error: 'Tesseract aborted',
        });
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
});

describe('Tesseract TSV geometry parsing', () => {
    it('uses line-level vertical geometry for word boxes', async () => {
        const { parseTsvOutput } = await import('@electron/ocr/worker/tesseractRunner');
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '4\t1\t1\t1\t1\t0\t10\t40\t160\t50\t-1\t',
            '5\t1\t1\t1\t1\t1\t10\t55\t70\t20\t92\tTITLE',
            '5\t1\t1\t1\t1\t2\t90\t65\t40\t12\t91\tword',
        ].join('\n');

        expect(parseTsvOutput(tsv)).toEqual([
            {
                text: 'TITLE',
                x: 10,
                y: 40,
                width: 70,
                height: 50,
            },
            {
                text: 'word',
                x: 90,
                y: 40,
                width: 40,
                height: 50,
            },
        ]);
    });
});
