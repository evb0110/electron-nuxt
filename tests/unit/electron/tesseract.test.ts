import { EventEmitter } from 'node:events';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    afterEach,
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
    public stdout = Object.assign(new EventEmitter(), { resume: vi.fn() });
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
vi.mock('@electron/ocr/resolveTesseractLanguageConfig', () => ({resolveTesseractLanguageConfig: mocks.resolveTesseractLanguageConfig}));

const PNG_SIGNATURE = Buffer.from([
    0x89,
    0x50,
    0x4E,
    0x47,
    0x0D,
    0x0A,
    0x1A,
    0x0A,
]);

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

        const { runOcr } = await import('@electron/ocr/runOcr');
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

        const { runOcr } = await import('@electron/ocr/runOcr');
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

        const { runOcr } = await import('@electron/ocr/runOcr');
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

    it('parses words and page text from a single TSV pass result', async () => {
        const { parseTsvOcrData } = await import('@electron/ocr/worker/tesseractRunner');
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '4\t1\t1\t1\t1\t0\t10\t40\t160\t50\t-1\t',
            '5\t1\t1\t1\t1\t1\t10\t55\t70\t20\t92\tFirst',
            '5\t1\t1\t1\t1\t2\t90\t65\t40\t12\t18\tfaint',
            '4\t1\t1\t1\t2\t0\t10\t110\t160\t30\t-1\t',
            '5\t1\t1\t1\t2\t1\t10\t115\t80\t12\t95\tSecond',
        ].join('\n');

        expect(parseTsvOcrData(tsv)).toEqual({
            words: [
                {
                    text: 'First',
                    x: 10,
                    y: 40,
                    width: 70,
                    height: 50,
                },
                {
                    text: 'Second',
                    x: 10,
                    y: 110,
                    width: 80,
                    height: 30,
                },
            ],
            text: 'First faint\nSecond',
        });
    });
});

describe('file-based Tesseract arguments', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();

        mocks.resolveTesseractLanguageConfig.mockReturnValue({
            orderedLanguages: ['eng'],
            extraConfigArgs: [
                '-c',
                'preserve_interword_spaces=1',
            ],
        });
    });

    it('adds public quality profile options without removing existing output config', async () => {
        const child = new MockChildProcess();
        mocks.spawn.mockReturnValue(child);

        const { runOcrFileBased } = await import('@electron/ocr/worker/tesseractRunner');
        const resultPromise = runOcrFileBased(
            '/tmp/page.png',
            ['eng'],
            1000,
            1500,
            300,
            '/mock/tesseract',
            '/mock/tessdata',
            1,
            undefined,
            {
                qualityProfile: 'poor-scan',
                pageSegmentationMode: 6,
            },
        );

        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalledTimes(1);
        });
        child.emit('close', 1);
        await resultPromise;

        expect(mocks.resolveTesseractLanguageConfig).toHaveBeenCalledWith(['eng'], {preserveDictionaries: false});
        expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
            '--psm',
            '6',
            '-c',
            'thresholding_method=2',
            '-c',
            'tessedit_create_tsv=1',
            '-c',
            'tessedit_create_pdf=1',
            '-c',
            'textonly_pdf=1',
        ]));
    });

    it('preserves dictionaries for the accurate quality profile', async () => {
        const child = new MockChildProcess();
        mocks.spawn.mockReturnValue(child);

        const { runOcrFileBased } = await import('@electron/ocr/worker/tesseractRunner');
        const resultPromise = runOcrFileBased(
            '/tmp/page.png',
            ['eng'],
            1000,
            1500,
            300,
            '/mock/tesseract',
            '/mock/tessdata',
            1,
            undefined,
            {qualityProfile: 'accurate'},
        );

        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalledTimes(1);
        });
        child.emit('close', 1);
        await resultPromise;

        expect(mocks.resolveTesseractLanguageConfig).toHaveBeenCalledWith(['eng'], {preserveDictionaries: true});
    });
});

describe('PNG dimension parsing', () => {
    let tempDir: string | null = null;

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
            tempDir = null;
        }
    });

    it('reads dimensions from the PNG header on disk', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-png-'));
        const imagePath = join(tempDir, 'page.png');
        const header = Buffer.alloc(24);
        PNG_SIGNATURE.copy(header, 0);
        header.writeUInt32BE(2048, 16);
        header.writeUInt32BE(1536, 20);
        await writeFile(imagePath, header);

        const { getPngDimensionsFromFile } = await import('@electron/ocr/worker/tesseractRunner');

        await expect(getPngDimensionsFromFile(imagePath)).resolves.toEqual({
            width: 2048,
            height: 1536,
        });
    });
});
