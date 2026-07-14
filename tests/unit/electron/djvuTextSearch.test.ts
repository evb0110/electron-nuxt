import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({runNativeCommand: vi.fn()}));

vi.mock('@electron/djvu/nativeToolPaths', () => ({getDjvuNativeToolPaths: () => ({djvused: '/tools/djvused'})}));
vi.mock('@electron/djvu/paths', () => ({buildDjvuRuntimeEnv: () => ({})}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));

const {
    createDjvuTextSExpressionParser,
    detectDjvuHasText,
    searchDjvuText,
} = await import('@electron/djvu/textSearch');

interface IRunOptions {
    onStdout?: (chunk: string) => void;
    signal?: AbortSignal;
}

const matchOptions = {
    matchCase: false,
    wholeWord: false,
    useRegex: false,
} as const;

function nativeResult() {
    return {
        command: '/tools/djvused',
        args: [],
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
    };
}

function abortError() {
    return new DOMException('Operation aborted', 'AbortError');
}

function streamOutput(output: string, chunkLength = 7) {
    mocks.runNativeCommand.mockImplementation(async (
        _command: string,
        _args: string[],
        options: IRunOptions,
    ) => {
        for (let offset = 0; offset < output.length; offset += chunkLength) {
            options.onStdout?.(output.slice(offset, offset + chunkLength));
            if (options.signal?.aborted) {
                throw abortError();
            }
        }
        return nativeResult();
    });
}

describe('DjVu native streamed text search', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('parses arbitrarily split text output and maps word boxes into top-left page coordinates', () => {
        const pages: Array<{
            pageNumber: number;
            text: string;
            zones: Array<{word?: {
                x: number;
                y: number;
                width: number;
                height: number
            } | undefined}>;
        }> = [];
        const parser = createDjvuTextSExpressionParser({onPage(page) {
            pages.push(page);
            return undefined;
        }});
        const output = '(page 0 0 1000 2000 (line 10 1500 900 1600 '
            + '(word 10 1500 120 1600 "Late") '
            + '(word 140 1500 360 1600 "needle\\040box")))';

        for (let offset = 0; offset < output.length; offset += 3) {
            parser.push(output.slice(offset, offset + 3));
        }

        expect(parser.finish()).toBe(1);
        expect(pages).toHaveLength(1);
        expect(pages[0]?.text).toBe('Late needle box');
        expect(pages[0]?.zones[0]?.word).toEqual({
            text: 'Late',
            x: 10,
            y: 400,
            width: 110,
            height: 100,
        });
    });

    it('decodes octal-escaped UTF-8 without damaging ordinary escapes or code points', () => {
        const pages: Array<{text: string}> = [];
        const parser = createDjvuTextSExpressionParser({onPage(page) {
            pages.push(page);
            return undefined;
        }});
        const output = '(page 0 0 1000 2000 (line 0 0 1000 100 '
            + '(word 0 0 100 100 "\\320\\237\\321\\200\\320\\265\\320\\264\\320\\270\\321\\201\\320\\273\\320\\276\\320\\262\\320\\270\\320\\265") '
            + '(word 110 0 300 100 "line\\nbreak") '
            + '(word 310 0 500 100 "Syriac ܐܪܡܝܐ 📖")))';

        for (let offset = 0; offset < output.length; offset += 5) {
            parser.push(output.slice(offset, offset + 5));
        }

        expect(parser.finish()).toBe(1);
        expect(pages).toHaveLength(1);
        expect(pages[0]?.text).toBe('Предисловие line\nbreak Syriac ܐܪܡܝܐ 📖');
    });

    it('finds text that exists only on a late page and streams incremental result geometry', async () => {
        streamOutput([
            '(page 0 0 1000 2000 "")',
            '(page 0 0 1000 2000 (line 10 1500 900 1600',
            ' (word 10 1500 130 1600 "Late")',
            ' (word 150 1500 350 1600 "Needle")))',
        ].join('\n'), 5);
        const progress = vi.fn();
        const onPageProcessed = vi.fn();

        const response = await searchDjvuText('/library/book.djvu', {
            requestId: 'late-page-search',
            pageCount: 2,
            query: 'needle',
            matchOptions,
            onPageProcessed,
            onProgress: progress,
        });

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(1);
        expect(response).toMatchObject({
            truncated: false,
            results: [{
                pageNumber: 2,
                pageMatchIndex: 0,
                matchIndex: 0,
                pageWidth: 1000,
                pageHeight: 2000,
                words: [{
                    text: 'Needle',
                    x: 150,
                    y: 400,
                    width: 200,
                    height: 100,
                }],
            }],
        });
        expect(progress).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'late-page-search',
            processed: 2,
            total: 2,
            resultsStartIndex: 0,
            results: [expect.objectContaining({pageNumber: 2})],
        }));
        expect(onPageProcessed.mock.calls.map(call => call[0])).toEqual([
            1,
            2,
        ]);
    });

    it('treats empty page syntax as empty and detects actual text on later pages', async () => {
        streamOutput([
            '(page 0 0 1000 2000 "")',
            '(page 0 0 1000 2000 (line 10 1500 900 1600',
            ' (word 10 1500 130 1600 "Found")))',
            '(page 0 0 1000 2000 "")',
        ].join('\n'), 11);

        await expect(detectDjvuHasText('/library/book.djvu')).resolves.toBe(true);
        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(1);

        streamOutput('(page 0 0 1000 2000 "")\n(page 0 0 1000 2000 "")');
        await expect(detectDjvuHasText('/library/empty.djvu')).resolves.toBe(false);
    });

    it('caps results, bounds progress payloads, and stops the native scan early', async () => {
        const words = Array.from({length: 501}, (_value, index) => (
            `(word ${index * 2} 1500 ${index * 2 + 1} 1600 "hit")`
        )).join(' ');
        streamOutput(`(page 0 0 2000 2000 (line 0 1500 1500 1600 ${words}))`, 32 * 1024);
        const progress = vi.fn();
        const onPageProcessed = vi.fn();

        const response = await searchDjvuText('/library/book.djvu', {
            requestId: 'bounded-search',
            pageCount: 10_000,
            query: 'hit',
            matchOptions,
            onPageProcessed,
            onProgress: progress,
        });

        expect(response.results).toHaveLength(500);
        expect(response.truncated).toBe(true);
        expect(progress.mock.calls
            .map(call => call[0].results?.length ?? 0)
            .every(resultCount => resultCount <= 64)).toBe(true);
        expect(onPageProcessed).toHaveBeenCalledWith(1);
        const nativeOptions = mocks.runNativeCommand.mock.calls[0]?.[2] as IRunOptions | undefined;
        expect(nativeOptions?.signal?.aborted).toBe(true);
    });

    it('kills the single native scan when its caller cancels', async () => {
        let nativeSignal: AbortSignal | undefined;
        mocks.runNativeCommand.mockImplementation((
            _command: string,
            _args: string[],
            options: IRunOptions,
        ) => new Promise((_resolve, reject) => {
            nativeSignal = options.signal;
            options.signal?.addEventListener('abort', () => reject(abortError()), {once: true});
        }));
        const controller = new AbortController();
        const pending = searchDjvuText('/library/book.djvu', {
            requestId: 'cancel-search',
            pageCount: 800,
            query: 'needle',
            matchOptions,
            signal: controller.signal,
        });

        controller.abort(new Error('caller canceled'));

        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(nativeSignal?.aborted).toBe(true);
        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(1);
    });
});
