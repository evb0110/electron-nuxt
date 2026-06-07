import type { TDocumentRef } from '@contracts/documentRef';
import type { IOcrWord } from '@contracts/shared';
import type {
    IOcrManifest,
    IOcrPageData,
    IOcrTextContentCache,
    IOcrTextContentCacheOptions,
} from '@app/utils/pdf-viewer/ocr-text-content-cache/ocrTextContentCacheTypes';

interface ICacheEntry<T> {
    value: T;
    estimatedBytes: number;
}

const DEFAULT_MAX_MANIFEST_ENTRIES = 16;

const DEFAULT_MAX_PAGE_ENTRIES = 128;

const DEFAULT_MAX_PAGE_BYTES = 64 * 1024 * 1024;

const PAGE_CACHE_KEY_SEPARATOR = '\u0000';

function makePageCacheKey(workingCopyPath: TDocumentRef, pageNumber: number) {
    return `${workingCopyPath}${PAGE_CACHE_KEY_SEPARATOR}${pageNumber}`;
}

function makePageCachePrefix(workingCopyPath: TDocumentRef) {
    return `${workingCopyPath}${PAGE_CACHE_KEY_SEPARATOR}`;
}

function estimateOcrWordBytes(word: IOcrWord) {
    return 40 + (word.text.length * 2);
}

function estimateOcrPageDataBytes(pageData: IOcrPageData) {
    let estimatedBytes = 96 + (pageData.text.length * 2);
    for (const word of pageData.words) {
        estimatedBytes += estimateOcrWordBytes(word);
    }
    return estimatedBytes;
}

class BoundedLruCache<T> {
    private readonly entries = new Map<string, ICacheEntry<T>>();

    private totalBytes = 0;

    constructor(
        private readonly options: {
            maxEntries: number;
            maxBytes?: number;
            estimateBytes?: (value: T) => number;
        },
    ) {}

    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }

        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: T) {
        const estimatedBytes = this.options.estimateBytes?.(value) ?? 0;
        if (
            typeof this.options.maxBytes === 'number'
            && estimatedBytes > this.options.maxBytes
        ) {
            return;
        }

        const existing = this.entries.get(key);
        if (existing) {
            this.totalBytes -= existing.estimatedBytes;
            this.entries.delete(key);
        }

        this.entries.set(key, {
            value,
            estimatedBytes,
        });
        this.totalBytes += estimatedBytes;
        this.trim();
    }

    delete(key: string) {
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }
        this.entries.delete(key);
        this.totalBytes -= entry.estimatedBytes;
        return true;
    }

    clear() {
        this.entries.clear();
        this.totalBytes = 0;
    }

    clearPrefix(prefix: string) {
        for (const key of [...this.entries.keys()]) {
            if (key.startsWith(prefix)) {
                this.delete(key);
            }
        }
    }

    get size() {
        return this.entries.size;
    }

    get bytes() {
        return this.totalBytes;
    }

    private trim() {
        while (
            this.entries.size > this.options.maxEntries
            || (
                typeof this.options.maxBytes === 'number'
                && this.totalBytes > this.options.maxBytes
            )
        ) {
            const oldestKey = this.entries.keys().next().value;
            if (!oldestKey) {
                break;
            }
            this.delete(oldestKey);
        }
    }
}

export function createOcrTextContentCache(
    options: IOcrTextContentCacheOptions = {},
): IOcrTextContentCache {
    const manifestCache = new BoundedLruCache<IOcrManifest | null>({maxEntries: options.maxManifestEntries ?? DEFAULT_MAX_MANIFEST_ENTRIES});
    const pageCache = new BoundedLruCache<IOcrPageData>({
        maxEntries: options.maxPageEntries ?? DEFAULT_MAX_PAGE_ENTRIES,
        maxBytes: options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES,
        estimateBytes: estimateOcrPageDataBytes,
    });

    return {
        getManifest(workingCopyPath: TDocumentRef) {
            return manifestCache.get(workingCopyPath);
        },
        setManifest(workingCopyPath: TDocumentRef, manifest: IOcrManifest | null) {
            manifestCache.set(workingCopyPath, manifest);
        },
        getPageData(workingCopyPath: TDocumentRef, pageNumber: number) {
            return pageCache.get(makePageCacheKey(workingCopyPath, pageNumber));
        },
        setPageData(workingCopyPath: TDocumentRef, pageNumber: number, pageData: IOcrPageData) {
            pageCache.set(makePageCacheKey(workingCopyPath, pageNumber), pageData);
        },
        clearCache(workingCopyPath?: TDocumentRef) {
            if (workingCopyPath) {
                manifestCache.delete(workingCopyPath);
                pageCache.clearPrefix(makePageCachePrefix(workingCopyPath));
                return;
            }

            manifestCache.clear();
            pageCache.clear();
        },
        getStats() {
            return {
                manifestEntries: manifestCache.size,
                pageEntries: pageCache.size,
                pageBytes: pageCache.bytes,
            };
        },
    };
}
