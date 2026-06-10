import { stat } from 'fs/promises';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION,
    getCompactSearchIndexPath,
    persistCompactSearchIndex,
} from '@electron/search/searchIndexSidecar';

export const NATIVE_SEARCH_INDEX_SCHEMA_VERSION = COMPACT_SEARCH_INDEX_SCHEMA_VERSION;
export const NATIVE_SEARCH_INDEX_MAGIC = COMPACT_SEARCH_INDEX_MAGIC;

const log = createLogger('native-search-index');

interface INativeSearchIndexInput {
    pages: Array<{
        pageNumber: number;
        text: string;
    }>;
    pageCount?: number;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

export function getNativeSearchIndexPath(pdfPath: string) {
    return getCompactSearchIndexPath(pdfPath);
}

async function statMtimeMs(filePath: string) {
    try {
        const fileStat = await stat(filePath);
        return typeof fileStat.mtimeMs === 'number' && Number.isFinite(fileStat.mtimeMs)
            ? fileStat.mtimeMs
            : null;
    } catch {
        return null;
    }
}

async function shouldRewriteNativeSearchIndex(pdfPath: string) {
    const [
        nativeMtimeMs,
        jsonMtimeMs,
    ] = await Promise.all([
        statMtimeMs(getNativeSearchIndexPath(pdfPath)),
        statMtimeMs(`${pdfPath}.index.json`),
    ]);
    return nativeMtimeMs === null || (jsonMtimeMs !== null && jsonMtimeMs > nativeMtimeMs);
}

export async function persistNativeSearchIndex(
    pdfPath: string,
    index: INativeSearchIndexInput,
    signal?: AbortSignal,
) {
    await persistCompactSearchIndex(pdfPath, {
        pageCount: index.pageCount ?? index.pages.length,
        pages: index.pages,
    }, signal);
    log.debug(`Native search index saved successfully: ${getNativeSearchIndexPath(pdfPath)}`);
}

export async function ensureNativeSearchIndexBestEffort(
    pdfPath: string,
    index: INativeSearchIndexInput,
    signal?: AbortSignal,
) {
    try {
        throwIfAborted(signal);
        if (!(await shouldRewriteNativeSearchIndex(pdfPath))) {
            return;
        }
        await persistNativeSearchIndex(pdfPath, index, signal);
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        log.debug(`Failed to save native search index: ${getErrorMessage(error)}`);
    }
}
