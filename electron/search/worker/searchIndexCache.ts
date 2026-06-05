import { stat } from 'fs/promises';
import { sortBy } from 'es-toolkit/array';
import { sumBy } from 'es-toolkit/math';
import type { IPdfSearchIndex } from '@electron/search/indexBuilder';
import {
    SEARCH_INDEX_SCHEMA_VERSION,
    buildSearchIndex,
    loadSearchIndex,
} from '@electron/search/indexBuilder';

export interface ICachedIndex {
    mtimeMs: number;
    sourceMtimeMs: number;
    index: IPdfSearchIndex;
    accessedAt: number;
    validatedTextBudget: boolean;
}

export interface ISearchIndexCacheOptions {
    maxEntries: number;
    ttlMs: number;
    maxPageTextBytes: number;
    maxTotalTextBytes: number;
}

interface IEnsureSearchIndexOptions {
    pageCount?: number;
    signal?: AbortSignal;
    throwIfCancelled: (signal?: AbortSignal) => void;
    onPageIndexed?: (page: IPdfSearchIndex['pages'][number]) => void;
}

function getIndexPath(pdfPath: string) {
    return `${pdfPath}.index.json`;
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

function pruneIndexCache(
    indexCache: Map<string, ICachedIndex>,
    options: ISearchIndexCacheOptions,
    now = Date.now(),
) {
    const freshEntries = Array.from(indexCache.entries())
        .filter(([
            ,
            entry,
        ]) => now - entry.accessedAt <= options.ttlMs);
    const retainedEntries = sortBy(
        freshEntries,
        [entry => entry[1].accessedAt],
    ).slice(Math.max(0, freshEntries.length - options.maxEntries));

    indexCache.clear();
    retainedEntries.forEach(([
        pdfPath,
        entry,
    ]) => indexCache.set(pdfPath, entry));
}

function validateIndexTextBudget(
    index: IPdfSearchIndex,
    options: ISearchIndexCacheOptions,
) {
    let totalTextBytes = 0;

    for (const page of index.pages) {
        const pageText = page.text ?? '';
        const pageTextBytes = Buffer.byteLength(pageText, 'utf8');
        if (pageTextBytes > options.maxPageTextBytes) {
            throw new Error(
                `Search index page ${page.pageNumber} is too large (${Math.round(pageTextBytes / 1024)}KB > `
                + `${Math.round(options.maxPageTextBytes / 1024)}KB limit)`,
            );
        }

        totalTextBytes += pageTextBytes;
        if (totalTextBytes > options.maxTotalTextBytes) {
            throw new Error(
                `Search index resident text budget exceeded (${Math.round(totalTextBytes / (1024 * 1024))}MB > `
                + `${Math.round(options.maxTotalTextBytes / (1024 * 1024))}MB limit)`,
            );
        }
    }
}

async function loadCachedIndex(
    indexCache: Map<string, ICachedIndex>,
    pdfPath: string,
    options: ISearchIndexCacheOptions,
): Promise<ICachedIndex | null> {
    const now = Date.now();
    pruneIndexCache(indexCache, options, now);
    const indexPath = getIndexPath(pdfPath);

    const mtimeMs = await statMtimeMs(indexPath);
    if (mtimeMs === null) {
        indexCache.delete(pdfPath);
        return null;
    }
    const sourceMtimeMs = await getSearchSourceMtimeMs(pdfPath);

    const cached = indexCache.get(pdfPath);
    if (cached && cached.mtimeMs === mtimeMs && cached.sourceMtimeMs === sourceMtimeMs) {
        const touched = {
            ...cached,
            accessedAt: now,
        };
        indexCache.set(pdfPath, touched);
        return touched;
    }

    if (sourceMtimeMs > mtimeMs) {
        indexCache.delete(pdfPath);
        return null;
    }

    const index = await loadSearchIndex(pdfPath);
    if (!index) {
        indexCache.delete(pdfPath);
        return null;
    }

    const entry: ICachedIndex = {
        mtimeMs,
        sourceMtimeMs,
        index,
        accessedAt: now,
        validatedTextBudget: true,
    };
    validateIndexTextBudget(entry.index, options);
    indexCache.set(pdfPath, entry);
    pruneIndexCache(indexCache, options, now);
    return entry;
}

async function cacheBuiltIndex(
    indexCache: Map<string, ICachedIndex>,
    pdfPath: string,
    index: IPdfSearchIndex,
    options: ISearchIndexCacheOptions,
): Promise<ICachedIndex> {
    const now = Date.now();
    pruneIndexCache(indexCache, options, now);
    const indexPath = getIndexPath(pdfPath);
    const mtimeMs = await statMtimeMs(indexPath) ?? Date.now();
    const sourceMtimeMs = await getSearchSourceMtimeMs(pdfPath);

    const entry: ICachedIndex = {
        mtimeMs,
        sourceMtimeMs,
        index,
        accessedAt: now,
        validatedTextBudget: true,
    };
    validateIndexTextBudget(entry.index, options);
    indexCache.set(pdfPath, entry);
    pruneIndexCache(indexCache, options, now);
    return entry;
}

function shouldRebuildCachedIndex(
    entry: ICachedIndex,
    expectedCount?: number,
) {
    if (entry.index.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION) {
        return true;
    }

    const hasAnyText = entry.index.pages.some(page => (page.text ?? '').length > 0);
    if (!hasAnyText && entry.index.pages.length > 0) {
        return true;
    }

    if (typeof expectedCount !== 'number' || expectedCount <= 0) {
        return false;
    }

    if (entry.index.pages.length < expectedCount) {
        return true;
    }

    const inRangeCount = sumBy(
        entry.index.pages,
        page => page.pageNumber >= 1 && page.pageNumber <= expectedCount ? 1 : 0,
    );

    return inRangeCount < expectedCount;
}

export async function ensureSearchIndex(
    indexCache: Map<string, ICachedIndex>,
    pdfPath: string,
    cacheOptions: ISearchIndexCacheOptions,
    ensureOptions: IEnsureSearchIndexOptions,
): Promise<ICachedIndex> {
    const expectedCount = ensureOptions.pageCount;
    const { signal } = ensureOptions;
    ensureOptions.throwIfCancelled(signal);

    let entry = await loadCachedIndex(indexCache, pdfPath, cacheOptions);
    ensureOptions.throwIfCancelled(signal);
    if (!entry || shouldRebuildCachedIndex(entry, expectedCount)) {
        const buildOptions: Parameters<typeof buildSearchIndex>[2] = {};
        if (expectedCount !== undefined) {
            buildOptions.pageCount = expectedCount;
        }
        if (signal !== undefined) {
            buildOptions.signal = signal;
        }
        if (ensureOptions.onPageIndexed !== undefined) {
            buildOptions.onPageIndexed = ensureOptions.onPageIndexed;
        }

        entry = await cacheBuiltIndex(
            indexCache,
            pdfPath,
            await buildSearchIndex(pdfPath, [], buildOptions),
            cacheOptions,
        );
        return entry;
    }

    if (!entry.validatedTextBudget) {
        validateIndexTextBudget(entry.index, cacheOptions);
        entry.validatedTextBudget = true;
    }

    return entry;
}
