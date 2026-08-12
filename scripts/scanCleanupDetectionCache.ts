import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    extname,
    join,
} from 'node:path';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
} from '@contracts/electronApiScanCleanup';
import {SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    DETECTION_DPI,
    PREVIEW_DPI,
} from '@scan-cleanup-core/detection';

export const SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION = 1 as const;
export const DEFAULT_SCAN_CLEANUP_DETECTION_CACHE_PATH = '.devkit/tmp/detection-cache';

const DETECTION_ALGORITHM_VERSION = 1 as const;
// Detection intentionally enumerates every source page; --pages is consumed
// only by the subsequent conversion pipeline and therefore is not a key input.
const DETECTION_SCOPE = 'all-source-pages' as const;

export interface IScanCleanupDetectionCacheKey {
    key: string;
    sourceSha256: string;
}

export interface IScanCleanupDetectionRunResult {results: IScanCleanupDetectionResult[];}

export interface IScanCleanupDetectionCacheRunRequest {
    cachePath?: string | undefined;
    detect: () => Promise<IScanCleanupDetectionRunResult>;
    key?: IScanCleanupDetectionCacheKey | undefined;
    log?: (message: string) => void;
    refresh: boolean;
}

interface IScanCleanupDetectionCacheFile {
    cacheFormatVersion: typeof SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION;
    detectionScope: typeof DETECTION_SCOPE;
    key: string;
    results: IScanCleanupDetectionResult[];
    sourceSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.every(item => isJsonValue(item));
    }
    return isRecord(value) && Object.values(value).every(item => isJsonValue(item));
}

function isLayoutClassification(value: unknown): value is IScanCleanupDetectionResult['classification'] {
    return value === 'single-uncut-page'
        || value === 'two-page-spread'
        || value === 'page-with-offcut';
}

function isDetectionResult(value: unknown): value is IScanCleanupDetectionResult {
    if (!isRecord(value) || !isJsonValue(value)) {
        return false;
    }
    const pageNumber = value.pageNumber;
    return typeof pageNumber === 'number'
        && Number.isSafeInteger(pageNumber)
        && pageNumber >= 1
        && isLayoutClassification(value.classification)
        && typeof value.confidence === 'number'
        && Number.isFinite(value.confidence)
        && (value.cutterXPx === null || (
            typeof value.cutterXPx === 'number' && Number.isFinite(value.cutterXPx)
        ))
        && isLayoutClassification(value.tier1Verdict)
        && typeof value.reconciled === 'boolean'
        && typeof value.clusterAgreement === 'number'
        && Number.isFinite(value.clusterAgreement)
        && (value.documentPrior === null || isRecord(value.documentPrior))
        && (value.revision === undefined || Number.isSafeInteger(value.revision));
}

function isCacheFile(value: unknown, expectedKey: IScanCleanupDetectionCacheKey): value is IScanCleanupDetectionCacheFile {
    if (!isRecord(value) || !isJsonValue(value)) {
        return false;
    }
    const results = value.results;
    if (
        value.cacheFormatVersion !== SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION
        || value.detectionScope !== DETECTION_SCOPE
        || value.key !== expectedKey.key
        || value.sourceSha256 !== expectedKey.sourceSha256
        || !Array.isArray(results)
        || results.length === 0
        || !results.every(result => isDetectionResult(result))
    ) {
        return false;
    }
    return results.every((result, index) => result.pageNumber === index + 1);
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(item => canonicalize(item));
    }
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map(key => [
                    key,
                    canonicalize(value[key]),
                ]),
        );
    }
    return value;
}

async function hashFile(path: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
            hash.update(chunk);
            continue;
        }
        throw new Error('Source PDF stream produced an unsupported chunk');
    }
    return hash.digest('hex');
}

function resolveCacheEntryPath(cachePath: string, key: IScanCleanupDetectionCacheKey) {
    return extname(cachePath).toLowerCase() === '.json'
        ? cachePath
        : join(cachePath, `${key.key}.json`);
}

export async function createScanCleanupDetectionCacheKey(
    sourcePdfPath: string,
    options: IScanCleanupOptions,
): Promise<IScanCleanupDetectionCacheKey> {
    const sourceSha256 = await hashFile(sourcePdfPath);
    const keyMaterial = canonicalize({
        architecture: process.arch,
        cacheFormatVersion: SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION,
        detectionAlgorithmVersion: DETECTION_ALGORITHM_VERSION,
        detectionScope: DETECTION_SCOPE,
        analysisDpi: DETECTION_DPI,
        nativeProtocolVersion: SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
        options,
        previewDpi: PREVIEW_DPI,
        sourceSha256,
        platform: process.platform,
    });
    const keyJson = JSON.stringify(keyMaterial);
    return {
        key: createHash('sha256').update(keyJson).digest('hex'),
        sourceSha256,
    };
}

export async function readScanCleanupDetectionCache(
    cachePath: string,
    key: IScanCleanupDetectionCacheKey,
): Promise<IScanCleanupDetectionResult[] | null> {
    const entryPath = resolveCacheEntryPath(cachePath, key);
    let serialized: string;
    try {
        serialized = await readFile(entryPath, 'utf8');
    } catch (error: unknown) {
        if (isRecord(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized) as unknown;
    } catch {
        return null;
    }
    return isCacheFile(parsed, key) ? parsed.results : null;
}

export async function writeScanCleanupDetectionCache(
    cachePath: string,
    key: IScanCleanupDetectionCacheKey,
    results: readonly IScanCleanupDetectionResult[],
) {
    const entryPath = resolveCacheEntryPath(cachePath, key);
    await mkdir(dirname(entryPath), {recursive: true});
    const cacheFile: IScanCleanupDetectionCacheFile = {
        cacheFormatVersion: SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION,
        detectionScope: DETECTION_SCOPE,
        key: key.key,
        results: [...results],
        sourceSha256: key.sourceSha256,
    };
    const temporaryPath = `${entryPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, JSON.stringify(cacheFile, null, 2) + '\n', 'utf8');
        await rename(temporaryPath, entryPath);
    } finally {
        await rm(temporaryPath, {force: true});
    }
}

export async function runScanCleanupDetectionWithCache({
    cachePath,
    detect,
    key,
    log = () => undefined,
    refresh,
}: IScanCleanupDetectionCacheRunRequest) {
    if (cachePath !== undefined && key !== undefined && !refresh) {
        const cachedResults = await readScanCleanupDetectionCache(cachePath, key);
        if (cachedResults !== null) {
            log(`detection cache hit ${key.key}`);
            return {results: cachedResults};
        }
        log(`detection cache miss ${key.key}`);
    }
    const result = await detect();
    if (cachePath !== undefined && key !== undefined) {
        await writeScanCleanupDetectionCache(cachePath, key, result.results);
        log(`detection cache wrote ${key.key}`);
    }
    return result;
}
