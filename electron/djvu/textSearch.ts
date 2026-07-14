import { buildDjvuRuntimeEnv } from '@electron/djvu/paths';
import { getDjvuNativeToolPaths } from '@electron/djvu/nativeToolPaths';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
    type IPdfSearchProgress,
    type IPdfSearchResponse,
} from '@contracts/search';
import {
    assembleSearchablePageText,
    buildPdfSearchExcerpt,
    findPdfSearchMatches,
    PDF_SEARCH_PROGRESS_RESULT_BATCH_LIMIT,
    validateSearchQuery,
    type IResolvedSearchMatchOptions,
} from '@pdf-core';
import type { IOcrWord } from '@contracts/shared';
import {
    createAbortError,
    isAbortError,
} from '@electron/utils/abort';

const DJVU_TEXT_TIMEOUT_MS = parseBoundedIntegerEnv(
    'EVB_DJVU_TEXT_TIMEOUT_MS',
    10 * 60 * 1_000,
    1_000,
    60 * 60 * 1_000,
);
const DJVU_TEXT_MAX_PAGE_CHARS = parseBoundedIntegerEnv(
    'EVB_DJVU_TEXT_MAX_PAGE_CHARS',
    8 * 1024 * 1024,
    1_024,
    64 * 1024 * 1024,
);
const DJVU_TEXT_MAX_PAGE_ZONES = parseBoundedIntegerEnv(
    'EVB_DJVU_TEXT_MAX_PAGE_ZONES',
    200_000,
    100,
    1_000_000,
);
const DJVU_TEXT_MAX_TOKEN_CHARS = parseBoundedIntegerEnv(
    'EVB_DJVU_TEXT_MAX_TOKEN_CHARS',
    1 * 1024 * 1024,
    1_024,
    8 * 1024 * 1024,
);
const DJVU_TEXT_MAX_DEPTH = 64;
const DJVU_TEXT_CAPTURED_STDOUT_BYTES = 32 * 1024;
const DJVU_TEXT_CAPTURED_STDERR_BYTES = 256 * 1024;
const DJVU_SEARCH_MAX_WORDS_PER_MATCH = 256;
const DJVU_SEARCH_PROGRESS_PAGE_BATCH = 8;
const INTERNAL_STOP_REASON = Symbol('djvu-text-internal-stop');

interface IDjvuTextZone {
    lineId: number | null;
    text: string;
    word?: IOcrWord | undefined;
}

interface IDjvuParsedTextPage {
    pageNumber: number;
    width: number;
    height: number;
    text: string;
    zones: IDjvuTextZone[];
    zoneOffsets: Array<{
        startOffset: number;
        endOffset: number;
    }>;
}

interface IDjvuTextFrame {
    childCount: number;
    kind: string | null;
    lineId: number | null;
    numbers: number[];
    text: string | null;
}

interface IDjvuPageBuildState {
    frame: IDjvuTextFrame;
    height: number;
    lineSequence: number;
    pageNumber: number;
    width: number;
    zones: IDjvuTextZone[];
}

interface IDjvuTextParserOptions {onPage: (page: IDjvuParsedTextPage) => false | undefined;}

interface IDjvuTextStreamOptions {
    onPage: (page: IDjvuParsedTextPage) => false | undefined;
    signal?: AbortSignal | undefined;
}

export interface ISearchDjvuTextOptions {
    matchOptions: IResolvedSearchMatchOptions;
    onPageProcessed?: ((processed: number) => void) | undefined;
    onProgress?: ((progress: IPdfSearchProgress) => void) | undefined;
    pageCount: number;
    query: string;
    requestId: string;
    signal?: AbortSignal | undefined;
}

function parseBoundedIntegerEnv(
    name: string,
    fallback: number,
    min: number,
    max: number,
) {
    const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
    return Number.isSafeInteger(parsed) && parsed >= min
        ? Math.min(parsed, max)
        : fallback;
}

function decodeDjvuString(raw: string) {
    let decoded = '';
    let octalBytes: number[] = [];

    function flushOctalBytes() {
        if (octalBytes.length === 0) {
            return;
        }
        decoded += Buffer.from(octalBytes).toString('utf8');
        octalBytes = [];
    }

    for (let index = 0; index < raw.length; index += 1) {
        const character = raw[index] ?? '';
        if (character !== '\\') {
            flushOctalBytes();
            const codePoint = raw.codePointAt(index);
            if (codePoint !== undefined) {
                decoded += String.fromCodePoint(codePoint);
                if (codePoint > 0xffff) {
                    index += 1;
                }
            }
            continue;
        }
        const escaped = raw[index + 1];
        if (escaped === undefined) {
            flushOctalBytes();
            decoded += '\\';
            continue;
        }
        if (/[0-7]/u.test(escaped)) {
            let octal = escaped;
            while (octal.length < 3 && /[0-7]/u.test(raw[index + 1 + octal.length] ?? '')) {
                octal += raw[index + 1 + octal.length];
            }
            octalBytes.push(Number.parseInt(octal, 8));
            index += octal.length;
            continue;
        }
        flushOctalBytes();
        decoded += ({
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
        } as Record<string, string>)[escaped] ?? escaped;
        index += 1;
    }
    flushOctalBytes();
    return decoded;
}

function positiveDimension(start: number | undefined, end: number | undefined) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return 0;
    }
    return Math.max(0, (end ?? 0) - (start ?? 0));
}

function createZone(frame: IDjvuTextFrame, page: IDjvuPageBuildState): IDjvuTextZone | null {
    if (frame.text === null || frame.text.length === 0) {
        return null;
    }
    const [
        x0,
        y0,
        x1,
        y1,
    ] = frame.numbers;
    const width = positiveDimension(x0, x1);
    const height = positiveDimension(y0, y1);
    const hasGeometry = width > 0
        && height > 0
        && Number.isFinite(page.height)
        && page.height > 0;
    return {
        lineId: frame.lineId,
        text: frame.text,
        ...(hasGeometry ? {word: {
            text: frame.text,
            x: Math.max(0, x0 ?? 0),
            y: Math.max(0, page.height - (y1 ?? 0)),
            width,
            height,
        }} : {}),
    };
}

function buildParsedPage(page: IDjvuPageBuildState): IDjvuParsedTextPage {
    const searchableItems = page.zones.map((zone, index) => {
        const nextZone = page.zones[index + 1];
        return {
            text: zone.text,
            separatorAfter: nextZone
                ? zone.lineId !== null && nextZone.lineId !== zone.lineId ? 'line' as const : 'space' as const
                : 'none' as const,
        };
    });
    if (searchableItems.length === 0 && page.frame.text) {
        searchableItems.push({
            text: page.frame.text,
            separatorAfter: 'none',
        });
        page.zones.push({
            lineId: null,
            text: page.frame.text,
        });
    }
    const assembled = assembleSearchablePageText(searchableItems);
    if (assembled.text.length > DJVU_TEXT_MAX_PAGE_CHARS) {
        throw new Error(`DjVu page ${page.pageNumber} text exceeds the supported limit`);
    }
    return {
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        text: assembled.text,
        zones: page.zones,
        zoneOffsets: assembled.itemOffsets.map(offset => ({
            startOffset: offset.startOffset,
            endOffset: offset.endOffset,
        })),
    };
}

/** Incremental bounded parser for DjVuLibre `djvused -e print-txt` output. */
export function createDjvuTextSExpressionParser(options: IDjvuTextParserOptions) {
    const stack: IDjvuTextFrame[] = [];
    let currentPage: IDjvuPageBuildState | null = null;
    let atom = '';
    let stringToken = '';
    let inString = false;
    let stringEscaped = false;
    let pageCount = 0;
    let failed: Error | null = null;
    let stopped = false;

    function assertHealthy() {
        if (failed) {
            throw failed;
        }
    }

    function fail(message: string): never {
        failed = new Error(message);
        throw failed;
    }

    function currentFrame() {
        const frame = stack.at(-1);
        if (!frame) {
            return fail('Malformed DjVu text output: token outside a list');
        }
        return frame;
    }

    function consumeAtom() {
        if (!atom) {
            return;
        }
        const frame = currentFrame();
        if (frame.kind === null) {
            frame.kind = atom;
            if (atom === 'page') {
                if (currentPage) {
                    fail('Malformed DjVu text output: nested page');
                }
                currentPage = {
                    frame,
                    height: 0,
                    lineSequence: 0,
                    pageNumber: pageCount + 1,
                    width: 0,
                    zones: [],
                };
            } else if (atom === 'line' && currentPage) {
                currentPage.lineSequence += 1;
                frame.lineId = currentPage.lineSequence;
            }
        } else if (frame.numbers.length < 4) {
            const numericValue = Number(atom);
            if (Number.isFinite(numericValue)) {
                frame.numbers.push(numericValue);
                if (frame.kind === 'page' && currentPage?.frame === frame && frame.numbers.length === 4) {
                    currentPage.width = positiveDimension(frame.numbers[0], frame.numbers[2]);
                    currentPage.height = positiveDimension(frame.numbers[1], frame.numbers[3]);
                }
            }
        }
        atom = '';
    }

    function consumeString() {
        const frame = currentFrame();
        frame.text = decodeDjvuString(stringToken);
        stringToken = '';
    }

    function openFrame() {
        if (stack.length >= DJVU_TEXT_MAX_DEPTH) {
            fail('DjVu text nesting exceeds the supported limit');
        }
        stack.push({
            childCount: 0,
            kind: null,
            lineId: stack.at(-1)?.lineId ?? null,
            numbers: [],
            text: null,
        });
    }

    function closeFrame() {
        consumeAtom();
        const frame = stack.pop();
        if (!frame) {
            fail('Malformed DjVu text output: unexpected closing parenthesis');
        }
        if (frame.kind === 'page') {
            if (!currentPage || currentPage.frame !== frame) {
                fail('Malformed DjVu text output: page ownership mismatch');
            }
            const parsedPage = buildParsedPage(currentPage);
            currentPage = null;
            pageCount += 1;
            stopped = options.onPage(parsedPage) === false;
        } else if (currentPage && frame.childCount === 0) {
            const zone = createZone(frame, currentPage);
            if (zone) {
                if (currentPage.zones.length >= DJVU_TEXT_MAX_PAGE_ZONES) {
                    fail(`DjVu page ${currentPage.pageNumber} text zones exceed the supported limit`);
                }
                currentPage.zones.push(zone);
            }
        }
        const parent = stack.at(-1);
        if (parent) {
            parent.childCount += 1;
        }
    }

    function push(chunk: string) {
        assertHealthy();
        try {
            for (const character of chunk) {
                if (inString) {
                    if (stringEscaped) {
                        stringToken += character;
                        stringEscaped = false;
                    } else if (character === '\\') {
                        stringToken += character;
                        stringEscaped = true;
                    } else if (character === '"') {
                        inString = false;
                        consumeString();
                    } else {
                        stringToken += character;
                    }
                    if (stringToken.length > DJVU_TEXT_MAX_TOKEN_CHARS) {
                        fail('DjVu text token exceeds the supported limit');
                    }
                    continue;
                }

                if (character === '(') {
                    consumeAtom();
                    openFrame();
                } else if (character === ')') {
                    closeFrame();
                } else if (character === '"') {
                    consumeAtom();
                    inString = true;
                } else if (/\s/u.test(character)) {
                    consumeAtom();
                } else {
                    atom += character;
                    if (atom.length > DJVU_TEXT_MAX_TOKEN_CHARS) {
                        fail('DjVu text token exceeds the supported limit');
                    }
                }
                if (stopped) {
                    break;
                }
            }
        } catch (error) {
            failed = error instanceof Error ? error : new Error(String(error));
            throw failed;
        }
    }

    function finish() {
        assertHealthy();
        consumeAtom();
        if (inString || stack.length > 0 || currentPage) {
            fail('Malformed or incomplete DjVu text output');
        }
        return pageCount;
    }

    return {
        finish,
        push,
        get stopped() {
            return stopped;
        },
    };
}

async function streamDjvuTextPages(filePath: string, options: IDjvuTextStreamOptions) {
    const { djvused } = getDjvuNativeToolPaths();
    const internalController = new AbortController();
    let internalStop = false;
    const parseFailure: {error: Error | null} = {error: null};
    const stop = () => {
        internalStop = true;
        internalController.abort(INTERNAL_STOP_REASON);
    };
    const relayAbort = () => internalController.abort(createAbortError());
    options.signal?.addEventListener('abort', relayAbort, {once: true});
    if (options.signal?.aborted) {
        relayAbort();
    }
    const parser = createDjvuTextSExpressionParser({onPage(page) {
        const shouldContinue = options.onPage(page);
        if (shouldContinue === false) {
            stop();
        }
        return shouldContinue;
    }});
    try {
        await runNativeCommand(djvused, [
            filePath,
            '-e',
            'print-txt',
        ], {
            env: buildDjvuRuntimeEnv(),
            timeoutMs: DJVU_TEXT_TIMEOUT_MS,
            maxStdoutBytes: DJVU_TEXT_CAPTURED_STDOUT_BYTES,
            maxStderrBytes: DJVU_TEXT_CAPTURED_STDERR_BYTES,
            commandLabel: 'djvused text stream',
            defaultCwdToCommandDir: true,
            prependCommandDirToPath: true,
            includeProcessEnv: true,
            windowsHide: true,
            signal: internalController.signal,
            onStdout(chunk) {
                if (parseFailure.error || internalController.signal.aborted) {
                    return;
                }
                try {
                    parser.push(chunk);
                    if (parser.stopped) {
                        stop();
                    }
                } catch (error) {
                    parseFailure.error = error instanceof Error ? error : new Error(String(error));
                    internalController.abort(parseFailure.error);
                }
            },
        });
        if (parseFailure.error) {
            throw parseFailure.error;
        }
        parser.finish();
    } catch (error) {
        if (parseFailure.error) {
            throw parseFailure.error;
        }
        if (!internalStop || !isAbortError(error)) {
            throw error;
        }
    } finally {
        options.signal?.removeEventListener('abort', relayAbort);
    }
    return {stop};
}

function wordsForPageRange(page: IDjvuParsedTextPage, startOffset: number, endOffset: number) {
    const words: IOcrWord[] = [];
    for (let index = 0; index < page.zoneOffsets.length; index += 1) {
        const offset = page.zoneOffsets[index];
        const word = page.zones[index]?.word;
        if (
            offset
            && word
            && offset.endOffset > startOffset
            && offset.startOffset < endOffset
        ) {
            words.push(word);
            if (words.length >= DJVU_SEARCH_MAX_WORDS_PER_MATCH) {
                break;
            }
        }
    }
    return words;
}

export async function searchDjvuText(
    filePath: string,
    options: ISearchDjvuTextOptions,
): Promise<IPdfSearchResponse> {
    validateSearchQuery(options.query, options.matchOptions);
    const results: IPdfSearchResponse['results'] = [];
    let processed = 0;
    let truncated = false;
    let pendingProgressResults: IPdfSearchResponse['results'] = [];
    let progressResultsStartIndex = 0;

    function emitProgress(force = false) {
        if (
            !options.onProgress
            || (!force
                && pendingProgressResults.length < PDF_SEARCH_PROGRESS_RESULT_BATCH_LIMIT
                && processed % DJVU_SEARCH_PROGRESS_PAGE_BATCH !== 0)
        ) {
            return;
        }
        options.onProgress({
            requestId: options.requestId,
            processed,
            total: options.pageCount,
            results: pendingProgressResults,
            resultsStartIndex: progressResultsStartIndex,
            truncated,
            status: 'running',
        });
        pendingProgressResults = [];
        progressResultsStartIndex = results.length;
    }

    await streamDjvuTextPages(filePath, {
        signal: options.signal,
        onPage(page) {
            processed = page.pageNumber;
            options.onPageProcessed?.(processed);
            const pageMatches = findPdfSearchMatches(page.text, options.query, options.matchOptions);
            for (const [
                pageMatchIndex,
                match,
            ] of pageMatches.entries()) {
                if (results.length >= SEARCH_RESULT_LIMIT) {
                    truncated = true;
                    break;
                }
                const words = wordsForPageRange(page, match.startOffset, match.endOffset);
                const result: IPdfSearchResponse['results'][number] = {
                    pageNumber: page.pageNumber as IPdfSearchResponse['results'][number]['pageNumber'],
                    pageMatchIndex,
                    matchIndex: results.length,
                    startOffset: match.startOffset,
                    endOffset: match.endOffset,
                    excerpt: buildPdfSearchExcerpt(
                        page.text,
                        match.startOffset,
                        match.endOffset,
                        SEARCH_EXCERPT_CONTEXT_CHARS,
                    ),
                    ...(words.length > 0 ? {
                        words,
                        pageWidth: page.width,
                        pageHeight: page.height,
                        rotation: 0 as const,
                    } : {}),
                };
                results.push(result);
                pendingProgressResults.push(result);
                emitProgress();
            }
            emitProgress(truncated);
            return truncated ? false : undefined;
        },
    });
    emitProgress(true);
    return {
        results,
        truncated,
    };
}

export async function detectDjvuHasText(filePath: string, signal?: AbortSignal) {
    let hasText = false;
    const localController = new AbortController();
    const relayAbort = () => localController.abort(createAbortError());
    signal?.addEventListener('abort', relayAbort, {once: true});
    if (signal?.aborted) {
        relayAbort();
    }
    try {
        await streamDjvuTextPages(filePath, {
            signal: localController.signal,
            onPage(page) {
                if (page.text.trim().length > 0) {
                    hasText = true;
                    return false;
                }
                return undefined;
            },
        });
    } catch (error) {
        if (!hasText || !isAbortError(error)) {
            throw error;
        }
    } finally {
        signal?.removeEventListener('abort', relayAbort);
    }
    return hasText;
}
