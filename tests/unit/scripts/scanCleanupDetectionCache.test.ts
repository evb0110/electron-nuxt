import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
} from '@contracts/electronApiScanCleanup';
import {
    createScanCleanupDetectionCacheKey,
    readScanCleanupDetectionCache,
    writeScanCleanupDetectionCache,
} from '@scripts/scanCleanupDetectionCache';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

const temporaryDirectories: string[] = [];

function detectorPaths(scanCleanupBinaryPath: string) {
    return {
        pdftoppmBinaryPath: process.execPath,
        scanCleanupBinaryPath,
    };
}

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    binarization: 'auto',
    normalizeIllumination: true,
    readingOrder: 'ltr',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckleLevel: 'normal',
    autoDewarp: false,
    autoDewarpDepth: undefined,
    skipBlankPages: false,
    pageOverrides: {},
};

const result: IScanCleanupDetectionResult = {
    pageNumber: 1,
    classification: 'single-uncut-page',
    confidence: 0.9,
    cutterXPx: null,
    documentPrior: null,
    tier1Verdict: 'single-uncut-page',
    reconciled: true,
    clusterAgreement: 1,
};

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
        force: true,
        recursive: true,
    })));
});

describe('scan-cleanup detection cache', () => {
    it('keys source bytes and every detection option canonically', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-detection-cache-key-'));
        temporaryDirectories.push(directory);
        const sourcePath = join(directory, 'source.pdf');
        const scanCleanupBinaryPath = join(directory, 'evb-scan-cleanup');
        await writeFile(sourcePath, 'source-a', 'utf8');
        await writeFile(scanCleanupBinaryPath, 'detector-a', 'utf8');

        const initial = await createScanCleanupDetectionCacheKey(
            sourcePath,
            options,
            detectorPaths(scanCleanupBinaryPath),
        );
        const reorderedOptions = {
            ...options,
            pageOverrides: {},
        };
        expect(await createScanCleanupDetectionCacheKey(
            sourcePath,
            reorderedOptions,
            detectorPaths(scanCleanupBinaryPath),
        )).toEqual(initial);
        expect(await createScanCleanupDetectionCacheKey(sourcePath, {
            ...options,
            matchPageSize: false,
        }, detectorPaths(scanCleanupBinaryPath))).not.toEqual(initial);

        await writeFile(sourcePath, 'source-b', 'utf8');
        expect(await createScanCleanupDetectionCacheKey(
            sourcePath,
            options,
            detectorPaths(scanCleanupBinaryPath),
        )).not.toEqual(initial);

        await writeFile(sourcePath, 'source-a', 'utf8');
        await writeFile(scanCleanupBinaryPath, 'detector-b-with-changed-bytes', 'utf8');
        expect(await createScanCleanupDetectionCacheKey(
            sourcePath,
            options,
            detectorPaths(scanCleanupBinaryPath),
        )).not.toEqual(initial);
    });

    it('round-trips results and rejects a cache entry for another key', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-detection-cache-file-'));
        temporaryDirectories.push(directory);
        const sourcePath = join(directory, 'source.pdf');
        const scanCleanupBinaryPath = join(directory, 'evb-scan-cleanup');
        const cachePath = join(directory, 'cache');
        await writeFile(sourcePath, 'source', 'utf8');
        await writeFile(scanCleanupBinaryPath, 'detector', 'utf8');
        const key = await createScanCleanupDetectionCacheKey(
            sourcePath,
            options,
            detectorPaths(scanCleanupBinaryPath),
        );

        await writeScanCleanupDetectionCache(cachePath, key, [result]);
        expect(await readScanCleanupDetectionCache(cachePath, key)).toEqual([result]);

        const cacheEntryPath = join(cachePath, `${key.key}.json`);
        const cacheFile = JSON.parse(await readFile(cacheEntryPath, 'utf8')) as Record<string, unknown>;
        cacheFile.key = 'wrong-key';
        await writeFile(cacheEntryPath, JSON.stringify(cacheFile), 'utf8');
        expect(await readScanCleanupDetectionCache(cachePath, key)).toBeNull();
    });
});
