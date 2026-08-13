import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {
    mkdir,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    extname,
    join,
    resolve,
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

export const SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION = 2 as const;
export const DEFAULT_SCAN_CLEANUP_DETECTION_CACHE_PATH = '.devkit/tmp/detection-cache';

const DETECTION_ALGORITHM_VERSION = 1 as const;
// Detection intentionally enumerates every source page; --pages is consumed
// only by the subsequent conversion pipeline and therefore is not a key input.
const DETECTION_SCOPE = 'all-source-pages' as const;

export interface IScanCleanupDetectionCacheKey {
    key: string;
    sourceSha256: string;
}

export interface IScanCleanupDetectionCacheDetectorPaths {
    pdftoppmBinaryPath: string;
    scanCleanupBinaryPath: string;
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

interface IScanCleanupDetectionCacheNativeBinaryHash {
    fingerprint: string;
    sha256: Promise<string>;
}

const nativeBinaryHashes = new Map<string, IScanCleanupDetectionCacheNativeBinaryHash>();
const pdftoppmVersions = new Map<string, Promise<string>>();

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
        throw new Error(`File stream produced an unsupported chunk: ${path}`);
    }
    return hash.digest('hex');
}

async function resolveAbsoluteToolPath(path: string) {
    return realpath(resolve(path));
}

async function hashNativeBinary(path: string) {
    const binaryStats = await stat(path, {bigint: true});
    if (!binaryStats.isFile()) {
        throw new Error(`Scan-cleanup detector is not a file: ${path}`);
    }
    const fingerprint = [
        binaryStats.dev,
        binaryStats.ino,
        binaryStats.size,
        binaryStats.mtimeNs,
        binaryStats.ctimeNs,
    ].join(':');
    const cached = nativeBinaryHashes.get(path);
    if (cached?.fingerprint === fingerprint) {
        return cached.sha256;
    }
    const sha256 = hashFile(path);
    nativeBinaryHashes.set(path, {
        fingerprint,
        sha256,
    });
    try {
        return await sha256;
    } catch (error: unknown) {
        if (nativeBinaryHashes.get(path)?.sha256 === sha256) {
            nativeBinaryHashes.delete(path);
        }
        throw error;
    }
}

function readPdftoppmVersion(path: string) {
    return new Promise<string>((resolvePromise, reject) => {
        execFile(path, ['-v'], {encoding: 'utf8'}, (error, stdout, stderr) => {
            if (error !== null) {
                reject(new Error(
                    `Could not read pdftoppm identity from ${path}: ${error.message}`,
                    {cause: error},
                ));
                return;
            }
            const version = `${stdout}${stderr}`.trim();
            if (version === '') {
                reject(new Error(`pdftoppm returned an empty version string: ${path}`));
                return;
            }
            resolvePromise(version);
        });
    });
}

function getPdftoppmVersion(path: string) {
    const cached = pdftoppmVersions.get(path);
    if (cached !== undefined) {
        return cached;
    }
    const version = readPdftoppmVersion(path);
    pdftoppmVersions.set(path, version);
    void version.catch(() => {
        if (pdftoppmVersions.get(path) === version) {
            pdftoppmVersions.delete(path);
        }
    });
    return version;
}

function resolveCacheEntryPath(cachePath: string, key: IScanCleanupDetectionCacheKey) {
    return extname(cachePath).toLowerCase() === '.json'
        ? cachePath
        : join(cachePath, `${key.key}.json`);
}

export async function createScanCleanupDetectionCacheKey(
    sourcePdfPath: string,
    options: IScanCleanupOptions,
    detectorPaths: IScanCleanupDetectionCacheDetectorPaths,
): Promise<IScanCleanupDetectionCacheKey> {
    const [
        sourceSha256,
        pdftoppmBinaryPath,
        scanCleanupBinaryPath,
    ] = await Promise.all([
        hashFile(sourcePdfPath),
        resolveAbsoluteToolPath(detectorPaths.pdftoppmBinaryPath),
        resolveAbsoluteToolPath(detectorPaths.scanCleanupBinaryPath),
    ]);
    const [
        pdftoppmVersion,
        scanCleanupBinarySha256,
    ] = await Promise.all([
        getPdftoppmVersion(pdftoppmBinaryPath),
        hashNativeBinary(scanCleanupBinaryPath),
    ]);
    const keyMaterial = canonicalize({
        architecture: process.arch,
        cacheFormatVersion: SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION,
        detectorIdentity: {
            pdftoppm: {
                absolutePath: pdftoppmBinaryPath,
                version: pdftoppmVersion,
            },
            scanCleanup: {sha256: scanCleanupBinarySha256},
        },
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
