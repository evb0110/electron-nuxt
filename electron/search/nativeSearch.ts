import { existsSync } from 'fs';
import {
    open,
    stat,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import type {
    ISearchMatch,
    ISearchResponse,
} from '@electron/search/protocol';
import type {
    IPdfSearchExcerpt,
    IResolvedSearchMatchOptions,
} from '@contracts/search';
import { toPageNumber } from '@contracts/pageNumbers';
import {
    EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@electron/config/constants';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { resolveOcrResourcesBase } from '@electron/ocr/resolveOcrResourcesBase';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';
import { isRecord } from '@contracts/runtimeGuards';
import {
    NATIVE_SEARCH_INDEX_MAGIC,
    NATIVE_SEARCH_INDEX_SCHEMA_VERSION,
    getNativeSearchIndexPath,
} from '@electron/search/nativeSearchIndex';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');
const HEADER_SIZE = 24;
const PAGE_RECORD_SIZE = 24;
const NATIVE_SEARCH_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_SEARCH_TIMEOUT_MS ?? '30000', 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 30_000;
    }
    return parsed;
})();

interface INativeSearchIndexMetadata {
    pageCount: number;
    pageRecordCount: number;
}

interface INativeSearchOptions extends IResolvedSearchMatchOptions {
    pdfPath: string;
    query: string;
    pageCount?: number;
    signal?: AbortSignal;
}

export interface INativeSearchResult {
    response: ISearchResponse;
    totalPages: number;
}

function getBinaryName() {
    return process.platform === 'win32'
        ? 'evb-pdf-search.exe'
        : 'evb-pdf-search';
}

function isNativeSearchDisabled() {
    return process.env.EVB_PDF_SEARCH_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env.EVB_PDF_SEARCH_ENABLE !== '1');
}

function resolveNativeSearchPath() {
    const overridePath = process.env.EVB_PDF_SEARCH_PATH?.trim();
    if (overridePath && existsSync(overridePath)) {
        return overridePath;
    }

    const binaryName = getBinaryName();
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = resolveOcrResourcesBase(__dirname, isPackaged);
    const candidates = [
        join(resourcesBase, 'pdf-search', platformArch, 'bin', binaryName),
        join(process.cwd(), 'native', 'pdf-search', 'target', 'release', binaryName),
    ];

    return candidates.find(candidate => existsSync(candidate)) ?? null;
}

export function isNativeSearchSupportedOptions(options: {
    query: string;
    matchCase: boolean;
    wholeWord: boolean;
    useRegex: boolean;
}) {
    if (options.useRegex || options.wholeWord || options.query.length === 0) {
        return false;
    }

    return true;
}

async function statMtimeMs(filePath: string) {
    try {
        return (await stat(filePath)).mtimeMs;
    } catch {
        return null;
    }
}

async function getSearchSourceMtimeMs(pdfPath: string) {
    const [
        pdfMtimeMs,
        ocrManifestMtimeMs,
    ] = await Promise.all([
        statMtimeMs(pdfPath),
        statMtimeMs(`${pdfPath}.ocr/manifest.json`),
    ]);

    return Math.max(pdfMtimeMs ?? 0, ocrManifestMtimeMs ?? 0);
}

async function loadNativeSearchIndexMetadata(indexPath: string): Promise<INativeSearchIndexMetadata | null> {
    const file = await open(indexPath, 'r');
    try {
        const header = Buffer.alloc(HEADER_SIZE);
        const { bytesRead } = await file.read(header, 0, HEADER_SIZE, 0);
        if (bytesRead !== HEADER_SIZE) {
            return null;
        }

        if (header.toString('ascii', 0, 8) !== NATIVE_SEARCH_INDEX_MAGIC) {
            return null;
        }

        const schemaVersion = header.readUInt32LE(8);
        if (schemaVersion !== NATIVE_SEARCH_INDEX_SCHEMA_VERSION) {
            return null;
        }

        const pageCount = header.readUInt32LE(12);
        const pageRecordCount = header.readUInt32LE(16);
        const fileStat = await file.stat();
        const minimumSize = HEADER_SIZE + pageRecordCount * PAGE_RECORD_SIZE;
        if (fileStat.size < minimumSize) {
            return null;
        }

        return {
            pageCount,
            pageRecordCount,
        };
    } finally {
        await file.close();
    }
}

async function isNativeSearchIndexFresh(pdfPath: string, expectedPageCount?: number) {
    const indexPath = getNativeSearchIndexPath(pdfPath);
    const [
        nativeMtimeMs,
        sourceMtimeMs,
    ] = await Promise.all([
        statMtimeMs(indexPath),
        getSearchSourceMtimeMs(pdfPath),
    ]);
    if (nativeMtimeMs === null || sourceMtimeMs > nativeMtimeMs) {
        return null;
    }

    const metadata = await loadNativeSearchIndexMetadata(indexPath);
    if (!metadata) {
        return null;
    }

    if (
        typeof expectedPageCount === 'number'
        && expectedPageCount > 0
        && (metadata.pageCount < expectedPageCount || metadata.pageRecordCount < expectedPageCount)
    ) {
        return null;
    }

    return {
        indexPath,
        metadata,
    };
}

function parseNativeSearchExcerpt(value: unknown): IPdfSearchExcerpt | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        typeof value.prefix !== 'boolean'
        || typeof value.suffix !== 'boolean'
        || typeof value.before !== 'string'
        || typeof value.match !== 'string'
        || typeof value.after !== 'string'
    ) {
        return null;
    }
    return {
        prefix: value.prefix,
        suffix: value.suffix,
        before: value.before,
        match: value.match,
        after: value.after,
    };
}

function parseFiniteInteger(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

function parseNativeSearchMatch(value: unknown): ISearchMatch | null {
    if (!isRecord(value)) {
        return null;
    }
    const excerpt = parseNativeSearchExcerpt(value.excerpt);
    const pageNumber = parseFiniteInteger(value.pageNumber);
    const pageMatchIndex = parseFiniteInteger(value.pageMatchIndex);
    const matchIndex = parseFiniteInteger(value.matchIndex);
    const startOffset = parseFiniteInteger(value.startOffset);
    const endOffset = parseFiniteInteger(value.endOffset);
    if (
        !excerpt
        || pageNumber === null
        || pageNumber < 1
        || pageMatchIndex === null
        || matchIndex === null
        || startOffset === null
        || endOffset === null
        || endOffset < startOffset
    ) {
        return null;
    }

    return {
        pageNumber: toPageNumber(pageNumber),
        pageMatchIndex,
        matchIndex,
        startOffset,
        endOffset,
        excerpt,
    };
}

function parseNativeSearchResponse(value: unknown): INativeSearchResult | null {
    if (!isRecord(value) || !Array.isArray(value.results) || typeof value.truncated !== 'boolean') {
        return null;
    }

    const pageCount = parseFiniteInteger(value.pageCount);
    if (pageCount === null) {
        return null;
    }

    const results: ISearchMatch[] = [];
    for (const result of value.results) {
        const parsedResult = parseNativeSearchMatch(result);
        if (!parsedResult) {
            return null;
        }
        results.push(parsedResult);
    }

    return {
        response: {
            results,
            truncated: value.truncated,
        },
        totalPages: pageCount,
    };
}

function createNativeSearchArgs(indexPath: string, options: INativeSearchOptions) {
    const args = [
        'search',
        '--index',
        indexPath,
        '--query',
        options.query,
        '--limit',
        String(SEARCH_RESULT_LIMIT),
        '--context',
        String(EXCERPT_CONTEXT_CHARS),
    ];
    if (options.matchCase) {
        args.push('--match-case');
    }
    if (options.pageCount !== undefined) {
        args.push('--page-count', String(options.pageCount));
    }
    return args;
}

export async function tryRunNativeSearch(options: INativeSearchOptions): Promise<INativeSearchResult | null> {
    if (isNativeSearchDisabled() || !isNativeSearchSupportedOptions(options)) {
        return null;
    }

    const binaryPath = resolveNativeSearchPath();
    if (!binaryPath) {
        return null;
    }

    const freshIndex = await isNativeSearchIndexFresh(options.pdfPath, options.pageCount);
    if (!freshIndex) {
        return null;
    }

    const commandOptions: Parameters<typeof runNativeToolCommand>[2] = {
        timeoutMs: NATIVE_SEARCH_TIMEOUT_MS,
        commandLabel: 'evb-pdf-search(search)',
    };
    if (options.signal !== undefined) {
        commandOptions.signal = options.signal;
    }

    const result = await runNativeToolCommand(
        binaryPath,
        createNativeSearchArgs(freshIndex.indexPath, options),
        commandOptions,
    );

    const parsed: unknown = JSON.parse(result.stdout ?? '');
    return parseNativeSearchResponse(parsed);
}
